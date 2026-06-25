package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/synergyplus/synergyplus/internal/queue"
	"github.com/synergyplus/synergyplus/internal/store"
)

// dataStore is the slice of the Postgres store the HTTP layer needs. *store.Store
// satisfies it; tests inject a fake so handler logic (authz, presign wiring) can
// be exercised without a database.
type dataStore interface {
	UserIDForKeyHash(ctx context.Context, keyHash string) (string, error)
	GetSimulation(ctx context.Context, id string) (*store.Simulation, error)
	GetResult(ctx context.Context, contentHash string) (*store.Result, error)
	HasResult(ctx context.Context, contentHash string) (bool, error)
	InsertSimulation(ctx context.Context, p store.InsertSimulationParams) (id, state string, err error)
	ListBatchSimulations(ctx context.Context, batchID string, limit, offset int) ([]store.Simulation, int, error)
	CreateBatch(ctx context.Context, userID string, total int, idempotencyKey *string) (string, error)
	GetBatch(ctx context.Context, id string) (*store.Batch, error)
	FindBatchByIdempotencyKey(ctx context.Context, userID, key string) (*store.Batch, error)
}

// presignClient mints presigned URLs and lists result objects. *storage.Presigner
// satisfies it; tests inject a fake to avoid a live S3.
type presignClient interface {
	PresignPut(ctx context.Context, bucket, key string) (string, error)
	PresignGet(ctx context.Context, bucket, key string) (string, error)
	List(ctx context.Context, bucket, prefix string) ([]storageObject, error)
	ExpiresIn() time.Duration
}

// Server holds the apiserver's dependencies and implements the CONTRACT §3 HTTP
// surface. The store is the Postgres source of truth; the expander materializes
// batches into queue rows. The presigner (optional) mints short-lived presigned
// upload/download URLs so researchers transfer files with only their API key.
type Server struct {
	store     dataStore
	expander  *queue.Expander
	presigner presignClient
	cfg       Config
	log       *slog.Logger
}

// NewServer constructs a Server. presigner may be nil (presigned upload/download
// endpoints then return 503); all other endpoints are unaffected.
func NewServer(s dataStore, expander *queue.Expander, presigner presignClient, cfg Config, log *slog.Logger) *Server {
	return &Server{store: s, expander: expander, presigner: presigner, cfg: cfg, log: log}
}

// Router builds the chi router: /healthz is open; everything under /v1 is behind
// the Bearer-token auth middleware (CONTRACT §3).
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/v1", func(r chi.Router) {
		r.Use(s.authMiddleware)
		r.Post("/simulations", s.handleCreateSimulation)
		r.Get("/simulations/{id}", s.handleGetSimulation)
		r.Post("/batches", s.handleCreateBatch)
		r.Get("/batches/{id}", s.handleGetBatch)
		r.Get("/batches/{id}/simulations", s.handleListBatchSimulations)
		r.Get("/results/{simId}", s.handleGetResult)
		r.Post("/uploads", s.handleCreateUpload)
		r.Get("/results/{simId}/artifacts", s.handleListArtifacts)
	})

	return r
}

// --- response helpers ---------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
