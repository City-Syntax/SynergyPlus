-- M-3 fix: idempotency keys are scoped per user, not globally. The original
-- global UNIQUE(idempotency_key) meant user B reusing a key user A had already
-- used hit the global constraint (B's per-user lookup missed), returning HTTP 500
-- and leaking that A had used the key. Scope the uniqueness to (user_id, key).
--
-- Idempotent: drop the old constraint/index if present, add the composite one if
-- absent.

-- The text UNIQUE column in 0001 created a unique constraint named
-- app.batches_idempotency_key_key. Drop it if it exists.
ALTER TABLE app.batches DROP CONSTRAINT IF EXISTS batches_idempotency_key_key;

-- Composite uniqueness: a user may reuse another user's idempotency key, but not
-- their own. NULL keys remain unconstrained (multiple non-idempotent batches OK).
CREATE UNIQUE INDEX IF NOT EXISTS batches_user_idempotency_key
  ON app.batches (user_id, idempotency_key);
