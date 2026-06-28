// Package store is the Postgres data-access layer for the apiserver. It owns a
// pgx connection pool, runs migrations on boot, and exposes typed queries for
// users, API keys, batches, simulations, and results. All SQL lives here so the
// HTTP and queue layers stay transport/logic only.
package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned by Get* queries when no row matches.
var ErrNotFound = errors.New("not found")

// Store wraps a pgx pool.
type Store struct {
	Pool *pgxpool.Pool
}

// New opens a pgx pool against databaseURL and pings it.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{Pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.Pool.Close() }

// Migrate reads every *.sql file in migrationsDir (lexically sorted) and applies
// it. Migrations are written to be idempotent (CREATE ... IF NOT EXISTS), so this
// is safe to run on every boot.
func (s *Store) Migrate(ctx context.Context, migrationsDir string) error {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations dir %q: %w", migrationsDir, err)
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".sql" {
			continue
		}
		files = append(files, e.Name())
	}
	sort.Strings(files)
	if len(files) == 0 {
		return fmt.Errorf("no .sql migrations found in %q", migrationsDir)
	}
	for _, f := range files {
		sql, err := os.ReadFile(filepath.Join(migrationsDir, f))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", f, err)
		}
		if _, err := s.Pool.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("apply migration %s: %w", f, err)
		}
	}
	return nil
}

// ResolveMigrationsDir picks the migrations directory: MIGRATIONS_DIR env, else
// /app/db/migrations (the in-container path), else ./db/migrations.
func ResolveMigrationsDir() string {
	if d := os.Getenv("MIGRATIONS_DIR"); d != "" {
		return d
	}
	for _, c := range []string{"/app/db/migrations", "./db/migrations"} {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			return c
		}
	}
	return "/app/db/migrations"
}

// --- Auth ---------------------------------------------------------------------

// UserIDForKeyHash returns the user_id owning a non-revoked API key whose
// key_hash matches. Returns ErrNotFound if no such active key exists.
func (s *Store) UserIDForKeyHash(ctx context.Context, keyHash string) (string, error) {
	var userID string
	err := s.Pool.QueryRow(ctx,
		`SELECT user_id::text FROM app.api_keys WHERE key_hash=$1 AND revoked_at IS NULL`,
		keyHash).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return userID, err
}

// --- Results ------------------------------------------------------------------

// Result is a row of app.results.
type Result struct {
	ContentHash       string
	Verdict           string
	Metrics           []byte // raw jsonb
	ArtifactURI       *string
	ArtifactExpiresAt *time.Time
	CreatedAt         time.Time
}

// GetResult returns the cached result for a content hash, or ErrNotFound.
func (s *Store) GetResult(ctx context.Context, contentHash string) (*Result, error) {
	var r Result
	err := s.Pool.QueryRow(ctx,
		`SELECT content_hash, verdict, metrics, artifact_uri, artifact_expires_at, created_at
		   FROM app.results WHERE content_hash=$1`, contentHash).
		Scan(&r.ContentHash, &r.Verdict, &r.Metrics, &r.ArtifactURI, &r.ArtifactExpiresAt, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// HasResult reports whether a result row exists for the content hash (cache hit).
func (s *Store) HasResult(ctx context.Context, contentHash string) (bool, error) {
	var exists bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM app.results WHERE content_hash=$1)`, contentHash).Scan(&exists)
	return exists, err
}

// --- Simulations --------------------------------------------------------------

// simulationColumns is the shared SELECT projection for app.simulations queries.
// Both GetSimulation and ListBatchSimulations use it so a column add/reorder
// only needs one edit and can't produce a mismatched Scan.
const simulationColumns = `id::text, batch_id::text, user_id::text, engine_version, priority,
	       model_ref, weather_ref, model_sha256, weather_sha256, extraction_spec,
	       content_hash, state, runner_id, attempts, error, created_at, started_at, finished_at`

// rowScanner is satisfied by both pgx.Row (QueryRow) and pgx.Rows (Query/Next),
// letting scanSimulation serve both code paths from a single function.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanSimulation scans one app.simulations row (projected via simulationColumns)
// into a Simulation value.
func scanSimulation(row rowScanner) (Simulation, error) {
	var sim Simulation
	err := row.Scan(&sim.ID, &sim.BatchID, &sim.UserID, &sim.EngineVersion, &sim.Priority,
		&sim.ModelRef, &sim.WeatherRef, &sim.ModelSHA256, &sim.WeatherSHA256, &sim.ExtractionSpec,
		&sim.ContentHash, &sim.State, &sim.RunnerID, &sim.Attempts, &sim.Error,
		&sim.CreatedAt, &sim.StartedAt, &sim.FinishedAt)
	return sim, err
}

// Simulation is a row of app.simulations (the fields the API surfaces).
type Simulation struct {
	ID             string
	BatchID        *string
	UserID         string
	EngineVersion  string
	Priority       int
	ModelRef       string
	WeatherRef     string
	ModelSHA256    *string
	WeatherSHA256  *string
	ExtractionSpec []byte
	ContentHash    *string
	State          string
	RunnerID       *string
	Attempts       int
	Error          *string
	CreatedAt      time.Time
	StartedAt      *time.Time
	FinishedAt     *time.Time
}

// InsertSimulationParams carries the fields for a single insert.
type InsertSimulationParams struct {
	BatchID        *string
	UserID         string
	EngineVersion  string
	Priority       int
	ModelRef       string
	WeatherRef     string
	ModelSHA256    *string
	WeatherSHA256  *string
	ExtractionSpec []byte // raw jsonb or nil
	ContentHash    string
	State          string // "queued" or "succeeded"
}

// InsertSimulation inserts one simulation and returns its generated id.
// The row's state always equals p.State — no trigger rewrites it on insert.
func (s *Store) InsertSimulation(ctx context.Context, p InsertSimulationParams) (id string, err error) {
	var finished *time.Time
	if p.State == "succeeded" {
		now := time.Now()
		finished = &now
	}
	err = s.Pool.QueryRow(ctx, `
		INSERT INTO app.simulations
			(batch_id, user_id, engine_version, priority, model_ref, weather_ref,
			 model_sha256, weather_sha256, extraction_spec, content_hash, state, finished_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING id::text`,
		p.BatchID, p.UserID, p.EngineVersion, p.Priority, p.ModelRef, p.WeatherRef,
		p.ModelSHA256, p.WeatherSHA256, nullableJSON(p.ExtractionSpec), p.ContentHash, p.State, finished,
	).Scan(&id)
	return id, err
}

func nullableJSON(b []byte) interface{} {
	if len(b) == 0 {
		return nil
	}
	return b
}

// GetSimulation returns a simulation by id, or ErrNotFound.
func (s *Store) GetSimulation(ctx context.Context, id string) (*Simulation, error) {
	sim, err := scanSimulation(s.Pool.QueryRow(ctx,
		`SELECT `+simulationColumns+` FROM app.simulations WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sim, nil
}

// ListBatchSimulations returns a page of a batch's simulations plus the total count.
func (s *Store) ListBatchSimulations(ctx context.Context, batchID string, limit, offset int) ([]Simulation, int, error) {
	var total int
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM app.simulations WHERE batch_id=$1`, batchID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+simulationColumns+` FROM app.simulations WHERE batch_id=$1
		  ORDER BY created_at ASC, id ASC
		  LIMIT $2 OFFSET $3`, batchID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Simulation
	for rows.Next() {
		sim, err := scanSimulation(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, sim)
	}
	return out, total, rows.Err()
}

// --- Batches ------------------------------------------------------------------

// batchColumns is the shared SELECT projection for app.batches queries.
// GetBatch and FindBatchByIdempotencyKey both use it via getBatchWhere.
const batchColumns = `id::text, user_id::text, state, total, succeeded, failed, idempotency_key, created_at`

// getBatchWhere executes a SELECT with batchColumns against app.batches with
// the supplied WHERE clause and positional arguments. Returns ErrNotFound when
// no row matches.
func (s *Store) getBatchWhere(ctx context.Context, where string, args ...any) (*Batch, error) {
	var b Batch
	err := s.Pool.QueryRow(ctx,
		`SELECT `+batchColumns+` FROM app.batches WHERE `+where, args...).
		Scan(&b.ID, &b.UserID, &b.State, &b.Total, &b.Succeeded, &b.Failed, &b.IdempotencyKey, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// Batch is a row of app.batches.
type Batch struct {
	ID             string
	UserID         string
	State          string
	Total          int
	Succeeded      int
	Failed         int
	IdempotencyKey *string
	CreatedAt      time.Time
}

// CreateBatch inserts a batch in 'expanding' state with its authoritative total
// (the known variant count). After this, batches.total is never rewritten and the
// app.sync_batch_counts trigger is the sole writer of succeeded/failed/state
// (migration 0004). idempotencyKey may be nil.
func (s *Store) CreateBatch(ctx context.Context, userID string, total int, idempotencyKey *string) (string, error) {
	var id string
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO app.batches (user_id, state, total, idempotency_key)
		 VALUES ($1, 'expanding', $2, $3) RETURNING id::text`, userID, total, idempotencyKey).Scan(&id)
	return id, err
}

// GetBatch returns a batch by id, or ErrNotFound.
func (s *Store) GetBatch(ctx context.Context, id string) (*Batch, error) {
	return s.getBatchWhere(ctx, "id=$1", id)
}

// FindBatchByIdempotencyKey returns the batch with a matching idempotency key
// for the user, or ErrNotFound.
func (s *Store) FindBatchByIdempotencyKey(ctx context.Context, userID, key string) (*Batch, error) {
	return s.getBatchWhere(ctx, "user_id=$1 AND idempotency_key=$2", userID, key)
}

// ResyncStuckBatches is a belt-and-suspenders sweep against any missed rollup
// trigger (H-1 defense). For every batch still 'expanding', 'queued' or 'running'
// whose children are all present (count = total) and all terminal, it recomputes
// succeeded/failed and forces state to 'done'. It performs the same recompute the
// trigger does, so it never disagrees with it. Returns the number of batches
// repaired.
func (s *Store) ResyncStuckBatches(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `
		UPDATE app.batches b SET
			succeeded = sub.succeeded,
			failed    = sub.failed,
			state     = 'done'
		FROM (
			SELECT batch_id,
			       count(*)                                                AS inserted,
			       count(*) FILTER (WHERE state = 'succeeded')             AS succeeded,
			       count(*) FILTER (WHERE state = 'failed')                AS failed,
			       count(*) FILTER (WHERE state IN ('queued','running'))   AS pending
			  FROM app.simulations
			 WHERE batch_id IS NOT NULL
			 GROUP BY batch_id
		) sub
		WHERE b.id = sub.batch_id
		  AND b.state IN ('expanding','queued','running')
		  AND b.total > 0
		  AND sub.inserted >= b.total
		  AND sub.pending = 0`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
