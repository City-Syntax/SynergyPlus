# SynergyPlus Runner (`synergy_runner`)

The long-lived **pull-loop worker** (CONTRACT §2, §5; PROPOSAL §6.4). One Runner
serves a single engine version. It loops:

**claim** a queued simulation → **fetch** model + weather → **run** the engine →
**parse** `eplusout.err` → **extract** Core Metrics → **upload** artifacts →
**write** the content-addressed result, while a background **heartbeat** thread
renews its lease.

## Engine modes

| Mode | Env | What it does |
|---|---|---|
| **Fake** (demo default) | `SP_FAKE_ENGINE=1` | Writes a synthetic `eplusout.err` and deterministic, plausible Core Metrics derived from the `content_hash`. No EnergyPlus binary needed — the slim `runner/Dockerfile` runs this. Sleeps `SP_FAKE_ENGINE_SECONDS`. |
| **Real** (default off) | `SP_FAKE_ENGINE` unset/0 | Runs `energyplus -w weather.epw -d out/ -r model.idf`, then extracts Core Metrics from `eplusout.sql` (a SQLite DB; table `TabularDataWithStrings`). Use `runner/Dockerfile.energyplus` (layers the Runner on `nrel/energyplus:${EPLUS_VERSION}`). |

**Only the engine is faked, not the fetch.** Inputs must really exist in object
storage. `_fetch_input` retries `SP_FETCH_ATTEMPTS` times (`SP_FETCH_RETRY_SECONDS`
apart) and then **fails the simulation** — a bogus `s3://` ref surfaces as a
failure instead of silently "succeeding" with synthetic metrics.

### Driving non-clean verdicts (`SP_FAKE_VERDICT`)

The fake engine emits a clean run by default. Set `SP_FAKE_VERDICT` to
`clean | warnings | severe | fatal` to make it write a matching `eplusout.err`
(e.g. a `** Severe  **` / `**  Fatal  **` line). This exercises `classify()` and
the verdict → succeeded/failed mapping end-to-end (`clean`/`warnings` ⇒ the sim
is `succeeded`; `severe`/`fatal` ⇒ `failed`, with `error=verdict=…`).

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
  `run_seconds`. Always present (value or null).
- **Upload** — every file under `out/` (incl. `eplusout.err`, `*.sql`,
  `synergy-summary.json`) to `s3://results/<content_hash>/`.
- **Result** — upsert `app.results` (idempotent on `content_hash` PK, ADR-0003).
  `artifact_expires_at` is set to `now() + SP_ARTIFACT_TTL_DAYS` when configured
  (the prune sweep itself is Phase-4). Then set the simulation `succeeded`/`failed`
  + `finished_at` — **fenced on `runner_id`** so a re-claimed/zombie runner can't
  clobber the new owner's terminal row (QA M-4).

## Run it locally

```bash
pip install -e runner/          # boto3 + psycopg v3 (psycopg2 also supported)

export DATABASE_URL="postgres://synergy:synergy@localhost:5432/synergy?sslmode=disable"
export S3_ENDPOINT="http://localhost:9000"
export S3_ACCESS_KEY=synergy S3_SECRET_KEY=synergypass S3_REGION=us-east-1
export SP_ENGINE_VERSION=24.1.0
export SP_FAKE_ENGINE=1          # demo mode; omit for real EnergyPlus

synergy-runner                  # or: python -m synergy_runner
```

Scale by starting more processes/replicas — `FOR UPDATE SKIP LOCKED` makes the
claim safe under concurrency.

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
| `SP_FAKE_ENGINE` | off | `1` → synthetic engine |
| `SP_FAKE_ENGINE_SECONDS` | `1` | fake run duration |
| `SP_FAKE_VERDICT` | `clean` | `clean\|warnings\|severe\|fatal` — fake `.err` to write |
| `SP_ENERGYPLUS_BIN` | `energyplus` | real-mode binary |
| `SP_ARTIFACT_TTL_DAYS` | unset | if set, stamp `results.artifact_expires_at` (GC is Phase-4) |

## Layout

```
synergy_runner/
  config.py     RunnerConfig.from_env() (CONTRACT §6)
  db.py         claim (§2.2), heartbeat (§2.3), back-fill (§2.1), result upsert/finalise
  heartbeat.py  background lease-renewal thread
  engine.py     real EnergyPlus + deterministic fake engine
  metrics.py    Core Metrics from eplusout.sql (SQLite)
  parse_err.py  .err → verdict (ported from worker/)
  storage.py    S3/MinIO + file:// download / upload_dir / sha256_file
  loop.py       claim → fetch → run → parse → extract → upload → write
  __main__.py   `synergy-runner` entrypoint
```
```
Dockerfile             slim python image (fake mode; the demo default)
Dockerfile.energyplus  real EnergyPlus variant (per engine version)
```
