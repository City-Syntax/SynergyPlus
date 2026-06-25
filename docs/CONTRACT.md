# SynergyPlus — Integration Contract (v0.2 build)

This is the **frozen interface** every component builds against so parallel work
integrates. If you need to change anything here, flag it to the PM — do not diverge
silently. Source of truth for *why*: `docs/PROPOSAL.md` + `docs/adr/`.

## 0. Local-run model

- **Primary runtime: Docker Compose** (`deploy/docker-compose.yml`). Services:
  `postgres`, `minio`, `minio-seed`, `apiserver`, `runner` (scalable), `portal`.
- **Kubernetes path (secondary):** `config/` — `RunnerPool` CRD, operator, KEDA
  ScaledObject, applied to the local OrbStack cluster.
- Runners are **identical** in both; they need only `DATABASE_URL` + S3 env. The
  operator is k8s-only and not required for the Compose demo.

## 1. Repository layout (who owns what)

```
db/migrations/          SQL schema           ← PM (frozen below)
cmd/apiserver/          Go: HTTP API + Expander + Reaper goroutines   ← Eng-Backend
cmd/operator/           Go: RunnerPool reconciler (k8s-only)          ← Eng-Backend
api/v1/                 Go: RunnerPool CRD types                      ← Eng-Backend
internal/{api,queue,store,controller}/  Go internals                  ← Eng-Backend
runner/synergy_runner/  Python pull-loop worker                       ← Eng-Runner
sdk/python/             Python SDK (update to this API)               ← Eng-Runner
deploy/seed/            sample model.idf + weather.epw + seed script  ← Eng-Runner
portal/                 TypeScript: Better Auth + developer portal    ← UIUX
deploy/docker-compose.yml, Makefile, TESTING.md                       ← PM
config/                 k8s manifests (CRD, operator, KEDA)           ← Eng-Backend
```

Agents touch **only their directories**. Shared files (`docker-compose.yml`,
`Makefile`, `go.mod` is Eng-Backend-only) are not edited by others.

## 2. Database schema (Postgres, single instance — ADR-0010)

Schemas: `app` (workload) and `auth` (Better Auth owns its own tables). Migration
`db/migrations/0001_init.sql` is authoritative; summary:

- **`app.users`** — `id uuid pk`, `email text unique`, `created_at`. (Mirrors the auth
  user; populated on first login / key creation. `user_id` everywhere = this `id`.)
- **`app.api_keys`** — `id uuid pk`, `user_id uuid`, `key_hash text unique` (sha256 of
  the raw key), `name text`, `created_at`, `revoked_at nullable`.
- **`app.batches`** — `id uuid pk`, `user_id`, `state text` (`expanding|queued|running|done`),
  `total int`, `succeeded int`, `failed int`, `idempotency_key text unique nullable`,
  `created_at`.
- **`app.simulations`** — the queue **and** run record:
  `id uuid pk`, `batch_id uuid null`, `user_id uuid`, `engine_version text`,
  `priority int` (0 low,1 normal,2 high), `model_ref text`, `weather_ref text`,
  `extraction_spec jsonb null`, `content_hash text`,
  `state text` (`queued|running|succeeded|failed`), `runner_id text null`,
  `lease_expires_at timestamptz null`, `attempts int default 0`, `max_attempts int default 3`,
  `created_at`, `started_at null`, `finished_at null`, `error text null`.
- **`app.results`** — `content_hash text pk`, `verdict text`, `metrics jsonb`,
  `artifact_uri text`, `artifact_expires_at timestamptz null`, `created_at`.

`app.simulations.content_hash` FKs logically to `app.results` (cache hit = row exists).

### 2.1 Content hash (deterministic, ADR-0003 — keyed on INPUTS)
```
content_hash = sha256( model_sha256 || ":" || weather_sha256 || ":" || engine_version )
```
SDK supplies `model_sha256`/`weather_sha256` (the `ArtifactRef.sha256`). If absent,
the Runner computes them after fetch and back-fills before writing the result.

### 2.2 Claim query (the one true claim — used by Runner AND KEDA trigger)
A Runner claims the highest-priority, oldest queued Simulation for its version whose
**User is under their concurrency cap**:
```sql
UPDATE app.simulations s
SET state='running', runner_id=$1, started_at=now(),
    lease_expires_at=now()+make_interval(secs => $4), attempts=attempts+1
WHERE s.id = (
  SELECT s2.id FROM app.simulations s2
  WHERE s2.state='queued' AND s2.engine_version=$2
    AND (SELECT count(*) FROM app.simulations r
         WHERE r.user_id=s2.user_id AND r.state='running') < $3   -- $3 = per-user cap
  ORDER BY s2.priority DESC, s2.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING s.*;
```
KEDA/eligible-depth uses the same predicate without the `UPDATE` (count of claimable rows).

### 2.3 Heartbeat & reap
- Heartbeat: `UPDATE app.simulations SET lease_expires_at=now()+make_interval(secs=>$2) WHERE id=$1 AND runner_id=$3`.
- Reaper (apiserver goroutine, every 15s): rows with `state='running' AND lease_expires_at < now()`
  → if `attempts < max_attempts` set `state='queued', runner_id=null, lease_expires_at=null`
  else `state='failed', error='lease expired', finished_at=now()`.

## 3. HTTP API (apiserver, REST, JSON)

Base: `http://localhost:8090`. Auth: `Authorization: Bearer <api_key>` on all `/v1/*`
except `/healthz`. Key validated by `sha256(key)` lookup in `app.api_keys` (not revoked)
→ `user_id`.

| Method | Path | Body / notes | Returns |
|---|---|---|---|
| GET | `/healthz` | — | `200 ok` |
| POST | `/v1/simulations` | `{engineVersion, model:{ref,sha256}, weather:{ref,sha256}, priority?, extractionSpec?}` | `201 {id, state}` |
| POST | `/v1/batches` | `{engineVersion, weather:{ref,sha256}, variants:[{model:{ref,sha256}, name?}], priority?, maxParallelism?, idempotencyKey?}` | `202 {batchId, state:"expanding"}` |
| GET | `/v1/simulations/{id}` | — | `200 {id, state, verdict?, result?}` |
| GET | `/v1/batches/{id}` | — | `200 {id, state, total, succeeded, failed}` |
| GET | `/v1/batches/{id}/simulations?limit&offset` | — | `200 {items:[...], total}` |
| GET | `/v1/results/{simId}` | — | `200 {verdict, metrics, artifactUri}` |

Submission ≤100 variants expands synchronously; larger goes async (state `expanding`).
`idempotencyKey` dedups batch submission.

## 4. Object storage (MinIO, S3 API)

Buckets: `models`, `weather`, `results`. Refs are `s3://<bucket>/<key>`. Result
artifacts uploaded under `s3://results/<content_hash>/` (incl. `eplusout.err`,
`*.sql`, `synergy-summary.json`). Local MinIO seeded with one sample model + weather
at these **fixed refs** (used by `deploy/smoke.sh` and TESTING.md):
- model:   `s3://models/sample/baseline.idf`
- weather: `s3://weather/sample/chicago.epw`

## 5. Core Metrics (ADR-0008) extracted into `results.metrics`

Always extract (keys, all numbers): `site_eui`, `source_eui`, `total_site_energy`,
`total_source_energy`, `unmet_heating_hours`, `unmet_cooling_hours`, `run_seconds`.
Pull from `eplusout.sql` (table `TabularDataWithStrings`) or the HTML; if unavailable,
emit nulls + keep `.err`. Optional `extraction_spec` adds more.

## 6. Shared env vars

```
DATABASE_URL=postgres://synergy:synergy@postgres:5432/synergy?sslmode=disable
S3_ENDPOINT=http://minio:9000      S3_REGION=us-east-1
S3_ACCESS_KEY=synergy              S3_SECRET_KEY=synergypass
S3_BUCKET_MODELS=models  S3_BUCKET_WEATHER=weather  S3_BUCKET_RESULTS=results
SP_ENGINE_VERSION=24.1.0           # runner: which version this pool serves
SP_RUNNER_ID=<hostname>            SP_LEASE_SECONDS=90  SP_HEARTBEAT_SECONDS=30
SP_PER_USER_CAP=50
APISERVER_ADDR=:8090
AUTH_URL=http://portal:3000        # apiserver may call portal for user upsert (optional)
# Added later:
SP_ALLOWED_ENGINE_VERSIONS=24.1.0  # apiserver: comma-sep allow-list; empty ⇒ accept any (M-1)
SP_FETCH_ATTEMPTS=3  SP_FETCH_RETRY_SECONDS=2   # runner: fetch retry before failing (L-3)
SP_ARTIFACT_TTL_DAYS=               # runner: if set, stamps results.artifact_expires_at (L-1)
# NOTE: the runner runs REAL EnergyPlus (nrel/energyplus base) — there is no fake mode.
```

## 7. Definition of done (per track)

- **Eng-Backend:** `go build ./...` clean; apiserver serves §3 against Postgres; operator
  builds; `config/` applies to a cluster; a `make smoke-api` hits the endpoints.
- **Eng-Runner:** runner claims→runs→writes results in a loop against Postgres+MinIO;
  runs **real EnergyPlus** (`nrel/energyplus:24.1.0` base); SDK does `submit_*/get_*/wait`;
  seed uploads a real example IDF+EPW that yields the Core Metrics.
- **UIUX:** portal runs (`npm run dev` and a Dockerfile), domain-restricted login
  (`@urbanflow.co`/`@nus.edu.sg`), API-key create/revoke UI writing to `app.api_keys`,
  good DX (docs, copy-paste examples). May stub email login for local (magic link to
  console) — document it.
- **QA:** breaks things, files findings in `docs/QA_REPORT.md`.

Every track ships a short `README.md` in its directory and is runnable from
`deploy/docker-compose.yml`.
