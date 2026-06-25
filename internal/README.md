# SynergyPlus backend (Go) — apiserver + operator

This tree implements the Eng-Backend scope of SynergyPlus v0.2: the HTTP API
gateway (`cmd/apiserver`), the RunnerPool operator (`cmd/operator` +
`internal/controller`), and the `RunnerPool` CRD (`api/v1`). Simulations and
Batches are **Postgres rows, not CRDs** (ADR-0006); the only custom resource is
`RunnerPool`.

## Packages

- **`internal/store`** — pgx connection pool, boot migrations (reads
  `db/migrations/*.sql`, idempotent), and all SQL: users/API keys, batches,
  simulations, results.
- **`internal/queue`** — workload logic with no HTTP: `ContentHash` (CONTRACT
  §2.1), the Batch `Expander` (sync ≤100 variants / async beyond; resolves the
  content-hash cache at expansion — cache hits are recorded `succeeded` and never
  queued, ADR-0007), and the `Reaper` goroutine (CONTRACT §2.3, every 15s).
- **`internal/api`** — config (env, CONTRACT §6), Bearer-token auth middleware
  (sha256-hex key lookup in `app.api_keys`), chi router, and the CONTRACT §3
  handlers.
- **`internal/controller`** — `RunnerPoolReconciler`: RunnerPool → Deployment of
  Runners + KEDA ScaledObject (eligible-depth trigger, CONTRACT §2.2 minus the
  UPDATE).

## HTTP surface (CONTRACT §3)

Base `http://localhost:8090`. `Authorization: Bearer <api_key>` on all `/v1/*`;
`/healthz` is open.

| Method | Path |
|---|---|
| GET  | `/healthz` |
| POST | `/v1/simulations` |
| GET  | `/v1/simulations/{id}` |
| POST | `/v1/batches` |
| GET  | `/v1/batches/{id}` |
| GET  | `/v1/batches/{id}/simulations?limit&offset` |
| GET  | `/v1/results/{simId}` |

## Run the apiserver locally

```sh
# 1. A Postgres (the Compose stack provides one; or run one ad-hoc):
docker run -d --name sp-pg -p 5432:5432 \
  -e POSTGRES_USER=synergy -e POSTGRES_PASSWORD=synergy -e POSTGRES_DB=synergy postgres:16

# 2. Point at it and at the migrations on disk, then run:
export DATABASE_URL='postgres://synergy:synergy@localhost:5432/synergy?sslmode=disable'
export MIGRATIONS_DIR=./db/migrations
go run ./cmd/apiserver
```

Migrations apply on boot. `MIGRATIONS_DIR` defaults to `/app/db/migrations`
(baked into the image) and falls back to `./db/migrations`.

### Engine-version allow-list (`SP_ALLOWED_ENGINE_VERSIONS`)

Comma-separated list of accepted `engineVersion` values, e.g.
`SP_ALLOWED_ENGINE_VERSIONS=24.1.0,24.2.0`. A submission targeting a version not
in the list is rejected at submit with `400 {"error":"unsupported engineVersion"}`
— this prevents a typo'd version from queuing forever with no RunnerPool to serve
it (QA M-1). **If the env is unset or empty, any version is accepted** (kept
flexible for local/dev). This is a CONTRACT §6 addition; flag to the PM to fold
into `docs/CONTRACT.md` (out of Eng-Backend's doc scope).

### Batch rollup (succeeded/failed/state)

`batches.total` is set once at creation from the variant count. The
`app.sync_batch_counts` trigger (migration `0004`) is the **sole** writer of
`succeeded`/`failed`/`state` thereafter, recomputing from `app.simulations` and
using the authoritative `total` for the done-check. The expander never writes
count snapshots (this was the QA H-1 lost-update bug). The Reaper also runs a
periodic `ResyncStuckBatches` sweep as a belt-and-suspenders repair.

### Mint a test API key

The portal owns key creation, but for a local smoke test insert one directly.
The stored hash is the **sha256 hex of the raw key**:

```sh
KEY=sk-test-123
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
psql "$DATABASE_URL" -c "INSERT INTO app.users(email) VALUES('dev@urbanflow.co') ON CONFLICT DO NOTHING;"
psql "$DATABASE_URL" -c "INSERT INTO app.api_keys(user_id,key_hash) SELECT id,'$HASH' FROM app.users WHERE email='dev@urbanflow.co';"

curl -s localhost:8090/healthz
curl -s -XPOST localhost:8090/v1/simulations -H "Authorization: Bearer $KEY" \
  -d '{"engineVersion":"24.1.0","model":{"ref":"s3://models/a.idf","sha256":"aa"},"weather":{"ref":"s3://weather/x.epw","sha256":"bb"}}'
```

## Operator / k8s path

`config/crd/synergyplus.io_runnerpools.yaml` (controller-gen output),
`config/samples/runnerpool.yaml`, `config/keda/scaledobject.yaml`,
`config/rbac/role.yaml`, `config/manager/manager.yaml`. The operator passes
CONTRACT §6 env through to Runner pods. KEDA ownership of `.spec.replicas` is
respected — the reconciler never sets a fixed replica count.

Regenerate deepcopy + CRD after editing `api/v1`:

```sh
controller-gen object paths=./api/v1/...
controller-gen crd paths=./api/v1/... output:crd:dir=config/crd
```
