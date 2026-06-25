-- ADR-0013: give the Simulation running-phase state machine ONE owner per
-- transition. The forward transitions (claim, heartbeat, finish) lived as Python
-- SQL in runner/synergy_runner/db.py and the recovery transition (requeue/fail on
-- lease expiry) lived as Go SQL in internal/queue/reaper.go. Splitting the state
-- machine across two runtimes meant the legal from-state and the runner_id fence
-- (M-4) were enforced in caller SQL — callers could express an illegal transition.
--
-- Push each running-phase transition behind a guarded SQL function that owns its
-- own legal from-state and its fence, so callers cannot express an illegal one.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

-- claim_simulation: the queued->running transition (CONTRACT §2.2).
--
-- Composes app.eligible_simulations (ADR-0011) as a MEMBERSHIP GATE: it is JOINed
-- to the base table so the row lock stays on app.simulations. `FOR UPDATE OF s2
-- SKIP LOCKED` locks the BASE TABLE row, never the function output (wrapping the
-- function in FOR UPDATE is a silent no-op on PG16 -> no LockRows node -> double
-- claims). LIMIT 1 takes the single highest-priority, oldest eligible row.
--
-- H-2 hard ceiling: the cap predicate inside eligible_simulations is a
-- count-then-claim that is racy across runners (TOCTOU) — N runners each read
-- `count < cap` before any locks, overshooting the cap by up to N-1. We take a
-- single transaction-scoped advisory lock (key 42) so the count+claim is atomic
-- across runners. A plpgsql function runs inside the CALLER's transaction, so the
-- xact lock is held under db.py's BEGIN/COMMIT and released on COMMIT — claims are
-- sub-millisecond so global serialisation is fine at our scale.
CREATE OR REPLACE FUNCTION app.claim_simulation(
  p_runner_id      text,
  p_engine_version text,
  p_user_cap       int,
  p_lease_seconds  int
) RETURNS SETOF app.simulations
LANGUAGE plpgsql AS $$
BEGIN
  -- H-2: serialise the count+claim across runners. Held until the caller COMMITs.
  PERFORM pg_advisory_xact_lock(42);

  RETURN QUERY
  UPDATE app.simulations s
  SET state            = 'running',
      runner_id        = p_runner_id,
      started_at       = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts         = attempts + 1
  WHERE s.id = (
    SELECT s2.id
    FROM app.simulations s2
    JOIN app.eligible_simulations(p_engine_version, p_user_cap) e ON e.id = s2.id
    ORDER BY s2.priority DESC, s2.created_at ASC
    FOR UPDATE OF s2 SKIP LOCKED
    LIMIT 1
  )
  RETURNING s.*;
END;
$$;

-- renew_lease: the heartbeat (CONTRACT §2.3). Owns from-state 'running' and the
-- M-4 runner_id fence; a heartbeat from a stale owner (its row was reaped and
-- re-claimed) affects 0 rows. Returns rows affected.
CREATE OR REPLACE FUNCTION app.renew_lease(
  p_sim_id        uuid,
  p_runner_id     text,
  p_lease_seconds int
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  UPDATE app.simulations
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE id = p_sim_id
    AND runner_id = p_runner_id
    AND state = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- finish_simulation: the terminal transition (running -> succeeded|failed).
-- Owns from-state 'running' and the M-4 runner_id fence: a late-waking zombie of a
-- runner whose row was reaped and re-claimed must NOT clobber the new owner's row.
-- Clears the lease. Returns rows affected (0 = lost the fence).
CREATE OR REPLACE FUNCTION app.finish_simulation(
  p_sim_id    uuid,
  p_runner_id text,
  p_succeeded bool,
  p_error     text
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  UPDATE app.simulations
  SET state            = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
      finished_at      = now(),
      error            = p_error,
      lease_expires_at = NULL
  WHERE id = p_sim_id
    AND runner_id = p_runner_id
    AND state = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- reap_expired_leases: the recovery transition (CONTRACT §2.3). Owns from-state
-- 'running' with an expired lease. This is EXPIRY-based, NOT runner_id-fenced (it
-- recovers dead/partitioned runners that can no longer fence themselves) — this
-- matches the previous reaper.go semantics exactly:
--   * expired + attempts < max_attempts -> queued (clear runner_id + lease)
--   * expired + attempts >= max_attempts -> failed, error='lease expired'
-- Returns the two counts so the caller can log them.
CREATE OR REPLACE FUNCTION app.reap_expired_leases()
RETURNS TABLE(requeued bigint, failed bigint)
LANGUAGE plpgsql AS $$
DECLARE
  n_requeued bigint;
  n_failed   bigint;
BEGIN
  WITH r AS (
    UPDATE app.simulations
    SET state='queued', runner_id=NULL, lease_expires_at=NULL
    WHERE state='running' AND lease_expires_at < now() AND attempts < max_attempts
    RETURNING 1
  )
  SELECT count(*) INTO n_requeued FROM r;

  WITH f AS (
    UPDATE app.simulations
    SET state='failed', error='lease expired', finished_at=now()
    WHERE state='running' AND lease_expires_at < now() AND attempts >= max_attempts
    RETURNING 1
  )
  SELECT count(*) INTO n_failed FROM f;

  requeued := n_requeued;
  failed   := n_failed;
  RETURN NEXT;
END;
$$;
