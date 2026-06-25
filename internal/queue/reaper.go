package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/synergyplus/synergyplus/internal/store"
)

// ReaperInterval is how often the Reaper sweeps for expired leases (CONTRACT §2.3).
const ReaperInterval = 15 * time.Second

// Reaper requeues simulations whose lease expired (a dead/partitioned Runner),
// up to max_attempts, after which they are failed (CONTRACT §2.3). It runs as an
// apiserver goroutine.
type Reaper struct {
	store *store.Store
	log   *slog.Logger
}

// NewReaper constructs a Reaper.
func NewReaper(s *store.Store, log *slog.Logger) *Reaper {
	return &Reaper{store: s, log: log}
}

// Run sweeps every ReaperInterval until ctx is cancelled.
func (r *Reaper) Run(ctx context.Context) {
	t := time.NewTicker(ReaperInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := r.sweep(ctx); err != nil {
				r.log.Error("reaper sweep failed", "err", err)
			} else if n > 0 {
				r.log.Info("reaper swept expired leases", "rows", n)
			}
			// Belt-and-suspenders against any missed batch-rollup trigger (H-1):
			// force-finish batches whose children are all present and terminal.
			if n, err := r.store.ResyncStuckBatches(ctx); err != nil {
				r.log.Error("batch resync failed", "err", err)
			} else if n > 0 {
				r.log.Info("reaper resynced stuck batches", "batches", n)
			}
		}
	}
}

// sweep performs one reap pass inside a transaction. Rows with an expired
// running lease and attempts remaining are requeued; the rest are failed.
// Returns the total number of rows acted on (requeued + failed).
//
// CONTRACT §2.3:
//   - attempts < max_attempts → state='queued', runner_id=null, lease_expires_at=null
//   - else                    → state='failed', error='lease expired', finished_at=now()
func (r *Reaper) sweep(ctx context.Context) (int64, error) {
	tx, err := r.store.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	requeue, err := tx.Exec(ctx, `
		UPDATE app.simulations
		   SET state='queued', runner_id=NULL, lease_expires_at=NULL
		 WHERE state='running' AND lease_expires_at < now() AND attempts < max_attempts`)
	if err != nil {
		return 0, err
	}
	fail, err := tx.Exec(ctx, `
		UPDATE app.simulations
		   SET state='failed', error='lease expired', finished_at=now()
		 WHERE state='running' AND lease_expires_at < now() AND attempts >= max_attempts`)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return requeue.RowsAffected() + fail.RowsAffected(), nil
}
