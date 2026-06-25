-- SynergyPlus v0.2 schema. Single Postgres instance (ADR-0010).
-- Applied automatically by the apiserver on boot (idempotent).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

CREATE SCHEMA IF NOT EXISTS app;

-- Users (mirrors the auth identity; user_id everywhere references app.users.id) ----
CREATE TABLE IF NOT EXISTS app.users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text UNIQUE NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- API keys (sha256 of the raw key is stored; raw key shown once at creation) -------
CREATE TABLE IF NOT EXISTS app.api_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    key_hash    text UNIQUE NOT NULL,
    name        text NOT NULL DEFAULT 'default',
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON app.api_keys(user_id);

-- Batches --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.batches (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES app.users(id),
    state            text NOT NULL DEFAULT 'expanding'
                       CHECK (state IN ('expanding','queued','running','done')),
    total            int  NOT NULL DEFAULT 0,
    succeeded        int  NOT NULL DEFAULT 0,
    failed           int  NOT NULL DEFAULT 0,
    idempotency_key  text UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Results (the content-addressed cache + the permanent index) ----------------------
CREATE TABLE IF NOT EXISTS app.results (
    content_hash         text PRIMARY KEY,
    verdict              text NOT NULL,                -- clean|warnings|severe|fatal
    metrics              jsonb NOT NULL DEFAULT '{}',  -- Core Metrics (+ extras)
    artifact_uri         text,
    artifact_expires_at  timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);

-- Simulations: the queue AND the run record ----------------------------------------
CREATE TABLE IF NOT EXISTS app.simulations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id          uuid REFERENCES app.batches(id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES app.users(id),
    engine_version    text NOT NULL,
    priority          int  NOT NULL DEFAULT 1,         -- 0 low, 1 normal, 2 high
    model_ref         text NOT NULL,
    weather_ref       text NOT NULL,
    model_sha256      text,
    weather_sha256    text,
    extraction_spec   jsonb,
    content_hash      text,
    state             text NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued','running','succeeded','failed')),
    runner_id         text,
    lease_expires_at  timestamptz,
    attempts          int  NOT NULL DEFAULT 0,
    max_attempts      int  NOT NULL DEFAULT 3,
    error             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    finished_at       timestamptz
);

-- The claim hot-path index: find queued rows for a version by priority then age.
CREATE INDEX IF NOT EXISTS sim_claim_idx
    ON app.simulations (engine_version, priority DESC, created_at)
    WHERE state = 'queued';

-- The reaper index: expired running leases.
CREATE INDEX IF NOT EXISTS sim_lease_idx
    ON app.simulations (lease_expires_at)
    WHERE state = 'running';

CREATE INDEX IF NOT EXISTS sim_batch_idx ON app.simulations(batch_id);
CREATE INDEX IF NOT EXISTS sim_user_running_idx
    ON app.simulations (user_id) WHERE state = 'running';
