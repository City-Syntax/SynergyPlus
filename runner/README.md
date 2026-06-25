# SynergyPlus Runner (`synergy_runner`)

The long-lived **pull-loop worker** (CONTRACT §2, §5; PROPOSAL §6.4). One Runner
serves a single engine version. It loops:

**claim** a queued simulation → **fetch** model + weather → **run** the engine →
**parse** `eplusout.err` → **extract** Core Metrics → **upload** artifacts →
**write** the content-addressed result, while a background **heartbeat** thread
renews its lease.

## Engine

The Runner always executes the real EnergyPlus binary:

```
energyplus -w weather.epw -d out/ -r model.idf
```

then extracts Core Metrics from `eplusout.sql` (a SQLite DB; table
`TabularDataWithStrings`, report `AnnualBuildingUtilityPerformanceSummary`). The
image is built `FROM nrel/energyplus:${EPLUS_VERSION}` (see `runner/Dockerfile`),
which puts `energyplus` on PATH; `SP_ENERGYPLUS_BIN` overrides the binary name.

Inputs must really exist in object storage. `_fetch_input` retries
`SP_FETCH_ATTEMPTS` times (`SP_FETCH_RETRY_SECONDS` apart) and then **fails the
simulation** — a bogus `s3://` ref surfaces as a failure (QA L-3).

## Flow detail

- **Claim** — the exact `UPDATE … FOR UPDATE SKIP LOCKED` from CONTRACT §2.2,
  cap-aware (`SP_PER_USER_CAP`). No row → sleep `SP_POLL_SECONDS` and retry.
  The count+claim runs under a transaction-scoped advisory lock
  (`pg_advisory_xact_lock`) so the per-user cap is a **hard** ceiling, not a racy
  TOCTOU check (QA H-2). Claims are sub-ms, so this serialisation is cheap.
- **Content hash** (CONTRACT §2.1) — `sha256(model_sha256 ":" weather_sha256 ":" engine_version)`.
  The Runner **always recomputes** the digests from the actually-fetched bytes
  and back-fills `model_sha256` / `weather_sha256` / `content_hash`. It never
  trusts an incoming placeholder hash (the API stores `sha256(":"+":"+ver)` for
  no-sha submissions) — trusting it would collide every no-sha sim onto one
  results row (QA C-1).
- **Heartbeat** (CONTRACT §2.3) — a daemon thread (own DB connection) renews
  `lease_expires_at` every `SP_HEARTBEAT_SECONDS`; only the owning `runner_id`
  can renew (fencing). Stopped when the sim finishes.
- **Verdict** — `clean | warnings | severe | fatal` from `eplusout.err`
  (`succeeded` = clean or warnings).
- **Core Metrics** (CONTRACT §5) — `site_eui`, `source_eui`, `total_site_energy`,
  `total_source_energy`, `unmet_heating_hours`, `unmet_cooling_hours`,
  `run_seconds`. Always present (value or null). Energy/EUI come from the
  `Site and Source Energy` table (`Total Energy` and `Energy Per Total Building
  Area` columns); unmet hours from `Comfort and Setpoint Not Met Summary`.
- **Upload** — every file under `out/` (incl. `eplusout.err`, `*.sql`,
  `synergy-summary.json`) to `s3://results/<content_hash>/`.
- **Result** — upsert `app.results` (idempotent on `content_hash` PK, ADR-0003).
  `artifact_expires_at` is set to `now() + SP_ARTIFACT_TTL_DAYS` when configured
  (the prune sweep itself is Phase-4). Then set the simulation `succeeded`/`failed`
  + `finished_at` — **fenced on `runner_id`** so a re-claimed/zombie runner can't
  clobber the new owner's terminal row (QA M-4).

## Run it locally

The Runner needs the `energyplus` binary on PATH, so run it from the image:

```bash
docker build -t ghcr.io/city-syntax/synergyplus-runner:24.1.0 runner/

docker run --rm --network <compose-net> \
  -e DATABASE_URL="postgres://synergy:synergy@postgres:5432/synergy?sslmode=disable" \
  -e S3_ENDPOINT="http://minio:9000" -e S3_REGION=us-east-1 \
  -e S3_ACCESS_KEY=synergy -e S3_SECRET_KEY=synergypass \
  -e SP_ENGINE_VERSION=24.1.0 \
  ghcr.io/city-syntax/synergyplus-runner:24.1.0
```

For code-only work (claim/loop/metrics) you can `pip install -e runner/` and run
`synergy-runner`, pointing `SP_ENERGYPLUS_BIN` at a local EnergyPlus install.

Scale by starting more processes/replicas — `FOR UPDATE SKIP LOCKED` plus the
per-claim advisory lock make claiming safe under concurrency.

## Environment (CONTRACT §6)

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres DSN |
| `S3_ENDPOINT` | — | MinIO/S3 URL (unset → AWS default) |
| `S3_REGION` | `us-east-1` | |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | |
| `S3_BUCKET_MODELS` / `_WEATHER` / `_RESULTS` | `models` / `weather` / `results` | |
| `SP_ENGINE_VERSION` | `24.1.0` | which version this pool serves |
| `SP_RUNNER_ID` | hostname | |
| `SP_LEASE_SECONDS` | `90` | initial + renewed lease length |
| `SP_HEARTBEAT_SECONDS` | `30` | renewal interval |
| `SP_PER_USER_CAP` | `50` | per-user running concurrency cap |
| `SP_POLL_SECONDS` | `2` | idle sleep between claim attempts |
| `SP_WORKSPACE` | `/tmp/synergy-runner` | scratch root (per-sim temp dirs) |
| `SP_FETCH_ATTEMPTS` | `3` | input download attempts before failing the sim |
| `SP_FETCH_RETRY_SECONDS` | `1` | delay between fetch attempts |
| `SP_ENERGYPLUS_BIN` | `energyplus` | EnergyPlus binary name/path |
| `SP_ARTIFACT_TTL_DAYS` | unset | if set, stamp `results.artifact_expires_at` (GC is Phase-4) |

## Layout

```
synergy_runner/
  config.py     RunnerConfig.from_env() (CONTRACT §6)
  db.py         claim (§2.2), heartbeat (§2.3), back-fill (§2.1), result upsert/finalise
  heartbeat.py  background lease-renewal thread
  engine.py     run the energyplus binary
  metrics.py    Core Metrics from eplusout.sql (SQLite)
  parse_err.py  .err → verdict (ported from worker/)
  storage.py    S3/MinIO + file:// download / upload_dir / sha256_file
  loop.py       claim → fetch → run → parse → extract → upload → write
  __main__.py   `synergy-runner` entrypoint
```
```
Dockerfile    FROM nrel/energyplus:${EPLUS_VERSION} + python3.11 + synergy_runner
```
