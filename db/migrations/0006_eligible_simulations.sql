-- ADR-0011: give the claim-eligibility predicate ONE home. The predicate
-- `state='queued' AND engine_version=p AND per-user running-count < cap` plus the
-- claim ordering (priority DESC, created_at ASC) from CONTRACT §2.2 / ADR-0005 was
-- duplicated in three runtimes that must agree: the Python claim (runner db.py),
-- the Go KEDA eligible-depth query (runnerpool_controller.go), and the KEDA
-- scaledobject doc sample. Centralise it here as a STABLE set-returning function.
--
-- The function owns the PREDICATE and the ORDERING only. It owns NEITHER row
-- locking NOR the UPDATE: callers that claim use it as a MEMBERSHIP GATE and keep
-- `FOR UPDATE ... SKIP LOCKED` on the BASE TABLE app.simulations. Wrapping the
-- function output with FOR UPDATE does NOT lock (verified on PG16: no LockRows
-- node, causing double-claims), so the lock MUST stay on the base table.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION app.eligible_simulations(
  p_engine_version text,
  p_user_cap       int
) RETURNS SETOF app.simulations
LANGUAGE sql STABLE AS $$
  SELECT s2.*
  FROM app.simulations s2
  WHERE s2.state = 'queued'
    AND s2.engine_version = p_engine_version
    AND (SELECT count(*) FROM app.simulations r
         WHERE r.user_id = s2.user_id AND r.state = 'running') < p_user_cap
  ORDER BY s2.priority DESC, s2.created_at ASC
$$;
