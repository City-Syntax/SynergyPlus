-- H-1 fix: make app.sync_batch_counts the SOLE writer of batches.succeeded /
-- failed / state once a batch leaves 'expanding'. The bug was a lost-update race:
-- the expander wrote a stale (total, succeeded, state) snapshot AFTER child sims
-- had already started finishing, clobbering the trigger's recomputed counts so
-- the batch never reached 'done'.
--
-- New contract:
--   * batches.total is set ONCE, at batch creation, from the known variant count.
--   * The expander never writes succeeded/failed/state snapshots.
--   * This trigger recomputes succeeded/failed from app.simulations on every child
--     INSERT or state change, and uses the authoritative batches.total for the
--     done-check: the batch transitions out of 'expanding' only once the number of
--     actually-inserted rows has reached total (so async expansion isn't pre-empted
--     mid-insert), and reaches 'done' only when every one of those total rows is
--     terminal.
--
-- Idempotent: CREATE OR REPLACE function + DROP/CREATE trigger.

CREATE OR REPLACE FUNCTION app.sync_batch_counts() RETURNS trigger AS $$
DECLARE
  bid uuid := COALESCE(NEW.batch_id, OLD.batch_id);
BEGIN
  IF bid IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE app.batches b SET
    succeeded = sub.succeeded,
    failed    = sub.failed,
    state = CASE
      -- Stay 'expanding' until every variant row has been inserted. total is the
      -- authoritative variant count set at creation; inserted is what exists now.
      WHEN sub.inserted < b.total THEN 'expanding'
      -- All rows present and all terminal -> done.
      WHEN b.total > 0 AND sub.done >= b.total THEN 'done'
      -- All rows present, at least one still running -> running.
      WHEN sub.running > 0 THEN 'running'
      -- All rows present, none running, not all terminal yet (queued) -> queued.
      ELSE 'queued'
    END
  FROM (
    SELECT
      count(*)                                                AS inserted,
      count(*) FILTER (WHERE state = 'succeeded')             AS succeeded,
      count(*) FILTER (WHERE state = 'failed')                AS failed,
      count(*) FILTER (WHERE state IN ('succeeded','failed')) AS done,
      count(*) FILTER (WHERE state = 'running')               AS running
    FROM app.simulations WHERE batch_id = bid
  ) sub
  WHERE b.id = bid;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sim_state_sync_batch ON app.simulations;
CREATE TRIGGER sim_state_sync_batch
  AFTER INSERT OR UPDATE OF state ON app.simulations
  FOR EACH ROW EXECUTE FUNCTION app.sync_batch_counts();
