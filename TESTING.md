# Testing SynergyPlus locally

Everything runs locally via Docker Compose. The runner runs **real EnergyPlus**
(`nrel/energyplus:24.1.0`), so the first build pulls a multi-GB base image and real runs
take seconds to ~a minute. The full flow is exercised end to end — submit → queue → claim →
**real EnergyPlus run** → `.err` verdict → metric extraction from `eplusout.sql` → result → cache.

## 0. Prerequisites

- Docker + Docker Compose (you have Compose v5).
- Free local ports: `8090` (API), `3000` (portal), `9000`/`9001` (MinIO), `5432` (Postgres).
- ~4 GB free disk for images.

## 1. Bring up the whole stack

```bash
make up           # = docker compose -f deploy/docker-compose.yml up --build -d
make ps           # watch until apiserver/postgres/minio are healthy
```

Services & URLs:
| Service | URL | Notes |
|---|---|---|
| API gateway | http://localhost:8090 | `GET /healthz` |
| Developer portal | http://localhost:3000 | login + API keys |
| MinIO console | http://localhost:9001 | user `synergy` / pass `synergypass` |
| Postgres | localhost:5432 | `synergy` / `synergy` / db `synergy` |

The **seed** job runs automatically once: creates buckets, uploads a sample model +
weather, and inserts a demo user with a known dev API key. Check it ran:
```bash
make logs S=seed     # ends with the dev key + sample refs banner
```

- **Dev API key:** `synergy-dev-key`
- **Sample inputs:** `s3://models/sample/baseline.idf`, `s3://weather/sample/chicago.epw`

## 2. Automated end-to-end smoke test (fastest check)

```bash
make smoke
```
This submits a simulation with the dev key, polls until it finishes, and prints the
result (verdict + Core Metrics). Expect `state=succeeded` and a metrics block.

## 3. Scale the runner pool

```bash
make scale N=4          # 4 runners pulling from the queue concurrently
make logs S=runner      # watch claims; SKIP LOCKED guarantees no double-claim
```
Submit several simulations (repeat `make smoke` or use the SDK) and watch them spread
across runners.

## 4. The developer portal (researcher DX)

1. Open http://localhost:3000 → **Login**.
2. Enter an email. **Only `@urbanflow.co` and `@nus.edu.sg` are accepted** (try another
   domain — it's rejected with a message). e.g. `you@nus.edu.sg`.
3. No mailbox is needed locally: the **magic link is printed to the portal logs and
   shown in the UI** ("Sign in now →"). `make logs S=portal` also shows it.
4. Go to **API Keys → Create key**. Copy the raw key (shown once).
5. Open **Getting Started** for copy-paste curl / SDK examples using your key.

Use your portal-minted key in place of `synergy-dev-key`:
```bash
curl -s localhost:8090/v1/simulations -H "Authorization: Bearer <your-key>" \
  -H 'Content-Type: application/json' \
  -d '{"engineVersion":"24.1.0","model":{"ref":"s3://models/sample/baseline.idf"},
       "weather":{"ref":"s3://weather/sample/chicago.epw"},"priority":1}'   # priority: 0 low, 1 normal, 2 high
```

## 5. Python SDK

```bash
pip install -e sdk/python
python - <<'PY'
from synergyplus import SynergyClient, ArtifactRef
sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")
sim = sp.submit_simulation(
    engine_version="24.1.0",
    model=ArtifactRef("s3://models/sample/baseline.idf"),
    weather=ArtifactRef("s3://weather/sample/chicago.epw"),
)
print("submitted", sim["id"])
print("final", sp.wait(sim["id"]))
print("results", sp.get_results(sim["id"]))
PY
```

## 6. Batches + the result cache

```bash
# Submit a 3-variant batch
curl -s localhost:8090/v1/batches -H "Authorization: Bearer synergy-dev-key" \
  -H 'Content-Type: application/json' \
  -d '{"engineVersion":"24.1.0","weather":{"ref":"s3://weather/sample/chicago.epw"},
       "variants":[{"model":{"ref":"s3://models/sample/baseline.idf"},"name":"a"},
                   {"model":{"ref":"s3://models/sample/baseline.idf"},"name":"b"},
                   {"model":{"ref":"s3://models/sample/baseline.idf"},"name":"c"}],
       "idempotencyKey":"demo-batch-1"}'
# → {"batchId":"...","state":"expanding"}; GET /v1/batches/<id> shows totals.
```
Re-submitting with the same `idempotencyKey` returns the same batch (no dupes). Once a
content hash has a result, re-submitting identical inputs is served from the **cache**
and never re-queued.

## 7. Inspect the data

```bash
# Queue / run state
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U synergy -d synergy -c "select id,state,verdict,engine_version from app.simulations order by created_at desc limit 10;"
# Result artifacts in MinIO → browse http://localhost:9001 → bucket 'results'
```

## 8. Testing the failure path (verdicts)

Verdicts come from real EnergyPlus `.err` output. Two easy ways to see the failure path
(`severe`/`fatal` → sim `failed`):

```bash
# (a) Missing input → fetch fails after retries → sim 'failed'
curl -s -H "Authorization: Bearer synergy-dev-key" -X POST localhost:8090/v1/simulations \
  -d '{"engineVersion":"24.1.0","model":{"ref":"s3://models/does-not-exist.idf"},
       "weather":{"ref":"s3://weather/sample/chicago.epw"}}'

# (b) Invalid model → EnergyPlus emits a Fatal → verdict=fatal → sim 'failed'.
#     Upload a broken IDF and submit it:
echo "this is not a valid IDF" > /tmp/broken.idf
# (use the SDK's upload_input or mc to put it at s3://models/broken.idf, then submit it)
```

## 9. Teardown

```bash
make down     # stop (keeps data volumes)
make clean    # stop + wipe Postgres/MinIO volumes (fresh start)
```

---

## Known limitations (v0.2)

These are deliberate scope/known items, not regressions (full detail in
`docs/QA_REPORT.md`):

- **`extractionSpec` is stored but not yet applied** (M-2) — only the 7 Core Metrics
  are produced today; custom extraction is Phase-2.
- **Artifact retention GC is not implemented** (L-1, ADR-0008 Phase-4) — `SP_ARTIFACT_TTL_DAYS`
  stamps an expiry, but no sweeper deletes expired artifacts yet.
- **Out-of-range `priority` is silently clamped** to 0–2 (L-4), no client warning.
- **At-least-once execution** (ADR-0003): a duplicate run is possible under a partition;
  results are input-keyed and idempotent so this is safe. The `claim_epoch` fence is
  deferred; `finish_simulation` is now `runner_id`-fenced (M-4) as a partial guard.

---

## Optional: the Kubernetes path (production-faithful)

The Compose stack is the workload data-plane; the `RunnerPool` operator + KEDA scaling
is the K8s-native deployment, runnable on your local OrbStack cluster:
```bash
make keda            # install KEDA
make k8s-deploy      # CRD + operator + a sample RunnerPool
kubectl get runnerpools,scaledobjects,deploy -A
```

