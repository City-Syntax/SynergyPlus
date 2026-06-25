# SynergyPlus — Autonomous Build Status

Live log of the overnight build (PM + 4 subagents). Implementing `docs/PROPOSAL.md`
v0.2 to run locally. Newest at top.

## Plan

| Track | Owner | Scope | Status |
|---|---|---|---|
| Contract + schema + compose + Makefile + integration | PM (me) | `db/`, `deploy/`, `Makefile`, `docs/` | 🟢 in progress |
| Backend: Go API + Expander + Reaper + RunnerPool operator | Eng-Backend | `cmd/`, `api/`, `internal/`, `config/` | ✅ done + verified |
| Runner: Python pull-loop + SDK + seed | Eng-Runner | `runner/`, `sdk/`, `deploy/seed/` | ✅ done + verified |
| Portal: Better Auth + dev portal | UIUX | `portal/` | ✅ done + verified |
| QA: break it, write findings | QA | `docs/QA_REPORT.md`, `qa/` | ✅ done (1C/2H/4M/4L) |
| Fix round: triage + reassign | PM + Eng agents | runner/, cmd/, internal/, db/ | ✅ done + re-verified |

## Approach

- **Primary local runtime = Docker Compose** (`deploy/docker-compose.yml`): postgres,
  minio, apiserver, runner (scalable), portal, seed. Runner defaults to
  `SP_FAKE_ENGINE=1` so the demo needs **no multi-GB EnergyPlus image**.
- **Kubernetes path** (operator + KEDA on OrbStack) ships as the production-faithful
  deployment via `make keda k8s-deploy`.
- Agents build in **disjoint directories** against the frozen `docs/CONTRACT.md`; PM
  owns the wiring and does integration + runs the stack.

## Log

- **Foundation laid:** `docs/CONTRACT.md` (frozen interface), `db/migrations/0001_init.sql`
  (queue/index/cache/auth schema), `deploy/docker-compose.yml`, `Makefile`,
  `deploy/smoke.sh`. Sample refs fixed: `s3://models/sample/baseline.idf`,
  `s3://weather/sample/chicago.epw`. Dev API key: `synergy-dev-key`.
- **3 build agents dispatched** in parallel (background). Base docker images warming.
- **All 3 build agents ✅ done + verified** (each tested its slice against real
  Postgres/MinIO). Cross-component contract details (sha256 API keys, content-hash
  recipe, integer priority) confirmed aligned across Go/Python/TS.
- **Integration ✅** — full stack up via `make up`; end-to-end smoke test passes
  (submit → queue → claim → run → parse → extract metrics → upload → cache → succeeded).
  Batch expand + idempotency + per-user concurrent claims + portal all verified.
- **Integration fixes applied (PM):**
  1. Go base images `golang:1.24 → 1.25` in both Dockerfiles (go.mod needs ≥1.25).
  2. Distroless apiserver has no shell/wget → replaced the Compose healthcheck with a
     Postgres `schema-ready` probe gating seed/runner/portal.
  3. `priority` is an **int** (0/1/2) system-wide — fixed my smoke script + TESTING.md
     (had the old `"normal"` string).
  4. **Bug found & fixed:** batch rollup (`succeeded`/`state`) wasn't updating as child
     sims finished → added `db/migrations/0003_batch_counts.sql` (recompute-from-source
     trigger, race-safe for concurrent runners). Verified batch → `done`.
- **QA ✅** — adversarial pass on the live stack: **1 Critical, 2 High, 4 Medium, 4 Low**
  (`docs/QA_REPORT.md`, repro scripts in `qa/`). Confirmed solid: no double-claims
  (30 sims/6 runners), reaper/lease/heartbeat/retry, cache-with-sha, auth, portal DX,
  data integrity. Real wins.
- **Fix round dispatched** (both eng agents resumed, parallel):
  - **Eng-Runner:** C-1 (content_hash never back-filled → different models collide —
    CRITICAL), M-4 (fence `finish_simulation`), H-2 (hard per-user cap via advisory
    lock), `SP_FAKE_VERDICT` knob (verdict-path testability), L-3 (real fetch in fake mode).
  - **Eng-Backend:** H-1 (async batch never `done` — expander/trigger race), M-3
    (idempotency key per-user), M-1 (validate `engineVersion`).
  - **Documented as deferred:** L-1 retention GC (Phase-4), L-4 priority-clamp DX,
    M-2 `extractionSpec` (not yet implemented).
- **Fixes shipped + re-verified on a CLEAN-ROOM rebuild** (`make clean && up` from
  scratch — all 5 migrations applied on boot, seed ran, stack healthy):
  | Check | Result |
  |---|---|
  | Smoke (submit→run→metrics→succeeded) | ✅ |
  | C-1 distinct models → distinct hashes | ✅ |
  | H-1 `qa/05` async 130-batch → `done 130/130` | ✅ ×3 |
  | H-2 `qa/04` cap=2 / 10 runners → peak 2 | ✅ |
  | M-1 unknown version → 400 | ✅ |
  | M-3 `qa/06` cross-user idempotency | ✅ |
  | Cache `qa/03` (honest shas) → hit, 1 result row | ✅ |
  | L-3 missing object → failed | ✅ |
  | `SP_FAKE_VERDICT=severe` → failed/verdict=severe | ✅ |
- Docs finalized: `TESTING.md` (9 scenarios + failure path + known-limitations),
  `QA_REPORT.md` (resolution table), `CONTRACT.md` (new env vars). Legacy `worker/`
  removed (superseded by `runner/`).
- **DONE.** Stack runs locally via `make up`; full test guide in `TESTING.md`.
