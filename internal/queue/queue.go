// Package queue owns the workload side of the apiserver: computing the
// content hash (CONTRACT §2.1), enqueuing single simulations, the async Batch
// Expander (CONTRACT §3 / ADR-0007), and the Reaper goroutine (CONTRACT §2.3).
//
// The queue itself is the app.simulations table; a "queued" row is a unit of
// work a Runner will claim. This package never talks HTTP — it is pure
// store + goroutine logic.
package queue

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"time"

	"github.com/synergyplus/synergyplus/internal/store"
)

// ContentHash computes the deterministic, input-keyed cache key (CONTRACT §2.1):
//
//	sha256( model_sha256 || ":" || weather_sha256 || ":" || engine_version )
//
// When the SDK omits an input sha256, the empty string is used here and the
// Runner back-fills the real hash after fetch (CONTRACT §2.1). The string is the
// exact concatenation hashed, so all components must agree across the codebase.
func ContentHash(modelSHA256, weatherSHA256, engineVersion string) string {
	sum := sha256.Sum256([]byte(modelSHA256 + ":" + weatherSHA256 + ":" + engineVersion))
	return hex.EncodeToString(sum[:])
}

// SyncExpandThreshold is the variant count at or below which a batch expands
// synchronously inside the request (CONTRACT §3). Larger batches return 202 and
// expand in a background goroutine.
const SyncExpandThreshold = 100

// Variant is one model variant of a batch submission.
type Variant struct {
	ModelRef    string
	ModelSHA256 string
	Name        string
}

// ExpandSpec carries everything the expander needs to materialize a batch into
// app.simulations rows.
type ExpandSpec struct {
	BatchID        string
	UserID         string
	EngineVersion  string
	WeatherRef     string
	WeatherSHA256  string
	Priority       int
	ExtractionSpec []byte // raw jsonb or nil
	Variants       []Variant
}

// Expander materializes accepted batches into queue rows, resolving the cache as
// it goes: a variant whose content_hash already has a result is inserted as
// 'succeeded' and never enters the queue (ADR-0007). Misses are inserted
// 'queued'. It is used both for the synchronous fast path and the async path.
type Expander struct {
	store *store.Store
	log   *slog.Logger
}

// NewExpander constructs an Expander.
func NewExpander(s *store.Store, log *slog.Logger) *Expander {
	return &Expander{store: s, log: log}
}

// Expand inserts all variants for spec.BatchID, then sets batch totals and
// transitions it to 'queued' (or 'done' if every variant was a cache hit). It is
// safe to call from a request goroutine (sync path) or its own goroutine (async).
//
// The expander does NOT write batch succeeded/failed/state snapshots (H-1): the
// batch's total is fixed at creation, and the app.sync_batch_counts trigger
// (migration 0004) recomputes counts and advances state from app.simulations as
// each row is inserted and as runners finish. Inserting all variant rows is the
// "expansion complete" signal — once inserted == total the trigger moves the
// batch out of 'expanding'.
func (e *Expander) Expand(ctx context.Context, spec ExpandSpec) error {
	for _, v := range spec.Variants {
		// CONTRACT §2.1: sha256(model_sha256 ":" weather_sha256 ":" engine_version).
		hash := ContentHash(v.ModelSHA256, spec.WeatherSHA256, spec.EngineVersion)

		state := "queued"
		// Resolve cache only when the SDK supplied input digests; without them
		// the hash is a placeholder and must not collide a real cached result.
		if v.ModelSHA256 != "" && spec.WeatherSHA256 != "" {
			hit, err := e.store.HasResult(ctx, hash)
			if err != nil {
				return err
			}
			if hit {
				state = "succeeded"
			}
		}

		p := store.InsertSimulationParams{
			BatchID:        &spec.BatchID,
			UserID:         spec.UserID,
			EngineVersion:  spec.EngineVersion,
			Priority:       spec.Priority,
			ModelRef:       v.ModelRef,
			WeatherRef:     spec.WeatherRef,
			ModelSHA256:    strPtr(v.ModelSHA256),
			WeatherSHA256:  strPtr(spec.WeatherSHA256),
			ExtractionSpec: spec.ExtractionSpec,
			ContentHash:    hash,
			State:          state,
		}
		if _, err := e.store.InsertSimulation(ctx, p); err != nil {
			return err
		}
	}
	return nil
}

// ExpandAsync runs Expand in a detached goroutine with its own context, logging
// any failure. Used for batches over SyncExpandThreshold.
func (e *Expander) ExpandAsync(spec ExpandSpec) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := e.Expand(ctx, spec); err != nil {
			e.log.Error("batch expansion failed", "batch_id", spec.BatchID, "err", err)
		} else {
			e.log.Info("batch expanded", "batch_id", spec.BatchID, "variants", len(spec.Variants))
		}
	}()
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
