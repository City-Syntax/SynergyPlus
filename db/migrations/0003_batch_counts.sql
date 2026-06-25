-- Keep app.batches rollup (succeeded/failed/state) in sync as child simulations
-- finish. Done with a trigger that RECOMPUTES from app.simulations (not +1/-1
-- counters) so concurrent Runners can't race/lose updates. Idempotent migration.

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
      WHEN b.state = 'expanding' THEN 'expanding'        -- don't pre-empt async expansion
      WHEN sub.total > 0 AND sub.done >= sub.total THEN 'done'
      WHEN sub.running > 0 THEN 'running'
      ELSE b.state
    END
  FROM (
    SELECT
      count(*)                                         AS total,
      count(*) FILTER (WHERE state = 'succeeded')      AS succeeded,
      count(*) FILTER (WHERE state = 'failed')         AS failed,
      count(*) FILTER (WHERE state IN ('succeeded','failed')) AS done,
      count(*) FILTER (WHERE state = 'running')        AS running
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
