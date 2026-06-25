# SynergyPlus — QA Report

**Date:** 2026-06-25
**Tester:** QA (adversarial)
**Build:** v0.2 (Docker Compose, `SP_FAKE_ENGINE=1`)
**Method:** Black-box API/SDK attacks + Postgres/MinIO ground-truth verification + source review.
Reusable repro scripts live under [`qa/`](../qa/).

## Severity counts

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 2 |
| Medium | 4 |
| Low | 4 |

## Resolution status (post-fix, re-verified on a clean-room rebuild)

| Finding | Status | Verified by |
|---|---|---|
| **C-1** content_hash collision | ✅ Fixed | runner recomputes real hash from fetched bytes; two distinct models → distinct hashes |
| **H-1** async batch never `done` | ✅ Fixed | `qa/05` → `done | 130/130` ×3 (migration 0004: trigger is sole authority + resync sweep) |
| **H-2** soft per-user cap | ✅ Fixed | `qa/04` CAP=2/10 runners → peak 2 (advisory lock serializes the claim) |
| **M-1** unknown engineVersion | ✅ Fixed | `99.9.9` → 400 (`SP_ALLOWED_ENGINE_VERSIONS`) |
| **M-3** cross-user idempotency 500 | ✅ Fixed | `qa/06` → both users get own batch (migration 0005: `UNIQUE(user_id, key)`) |
| **M-4** unfenced finish | ✅ Fixed | `finish_simulation` now `AND runner_id=me` |
| **L-2** verdict paths untested | ✅ Addressed | `SP_FAKE_VERDICT` knob → `severe` ⇒ `failed` verified e2e |
| **L-3** fake mode masks bad input | ✅ Fixed | missing object → sim `failed` (real fetch + retry) |
| **M-2** extractionSpec ignored | ⏳ Deferred (Phase-2) | documented in TESTING.md known-limitations |
| **L-1** retention GC | ⏳ Deferred (Phase-4) | `SP_ARTIFACT_TTL_DAYS` stamps expiry; sweeper not built |
| **L-4** silent priority clamp | ⏳ Won't-fix (minor) | documented |

Note: `qa/03_cache.sh` was updated to send the **real** sample-object shas — post-C-1
the cache keys on actual fetched bytes, so the old synthetic-sha assumption no longer
drives the stored hash (the SDK always hashes real files). The honest-client cache hit
is verified: 2nd submit → `succeeded` immediately, exactly one `app.results` row.

## Top issues (read these first)

1. **C-1 — No-sha submissions collide on one content hash → silent wrong results / cache poisoning.** Two different models submitted without `sha256` produce the *same* `content_hash` and share one `app.results` row + artifacts. A researcher can get another model's metrics back.
2. **H-1 — Async batches (>100 variants) never reach `done`.** A lost-update race between the expander's `SetBatchTotals` and the per-sim rollup trigger leaves the batch permanently `running` with `succeeded` 1–2 short of `total`. Clients polling for `done` hang forever. Reproduced 4/4.
3. **H-2 — Per-user concurrency cap is soft, not hard (TOCTOU).** With 10 runners and cap=2, peak concurrent `running` for one user reached 3. The cap can be exceeded by up to (#runners−1) under load.
4. **M-3 — Cross-user idempotency key collision returns HTTP 500.** `idempotency_key` is globally `UNIQUE` but looked up per-user; if user B reuses a key user A already used, B's submit 500s.
5. **M-1 — Unknown `engineVersion` is accepted and queues forever.** No RunnerPool/validation; the sim sits `queued` with no error and no timeout.

---

## Critical

### C-1 — No-sha submissions all collide on one content hash (silent data corruption)

**Component:** `runner/synergy_runner/loop.py:70` (and the API insert in `internal/api/handlers.go:57` / `internal/queue/queue.go:80`).

When a simulation is submitted **without** `model.sha256`/`weather.sha256`, the API computes a *placeholder* content hash `sha256(":" + ":" + engineVersion)` and stores it on the row. CONTRACT §2.1 says the Runner must back-fill the **real** hash after fetch. It does not: in `loop.py`

```python
ch = sim.get("content_hash") or content_hash(model_sha, weather_sha, sim["engine_version"])
```

`sim["content_hash"]` is already the placeholder (truthy), so `ch` stays the placeholder. The back-fill that follows writes `content_hash = ch` (still the placeholder). Result: **every** no-sha sim for a given engine version maps to the *same* `content_hash`, writes to the *same* `app.results` row (upsert), and uploads to the *same* `s3://results/<placeholder>/` prefix. The `model_sha256`/`weather_sha256` columns get the real values, but `content_hash` never does.

**Repro (proven with two genuinely different models):**
```bash
# upload two distinct models
docker compose -f deploy/docker-compose.yml exec -T minio sh -c '
  mc alias set local http://localhost:9000 synergy synergypass
  printf "MODEL-ALPHA-%s" "$(date)" | mc pipe local/models/qa/alpha.idf
  printf "MODEL-BRAVO-%s" "$(date)" | mc pipe local/models/qa/bravo.idf'
# submit BOTH without sha256
curl -s -H "Authorization: Bearer synergy-dev-key" -X POST localhost:8090/v1/simulations \
  -d '{"engineVersion":"24.1.0","model":{"ref":"s3://models/qa/alpha.idf"},"weather":{"ref":"s3://weather/sample/chicago.epw"}}'
curl -s -H "Authorization: Bearer synergy-dev-key" -X POST localhost:8090/v1/simulations \
  -d '{"engineVersion":"24.1.0","model":{"ref":"s3://models/qa/bravo.idf"},"weather":{"ref":"s3://weather/sample/chicago.epw"}}'
# GET both results → identical content_hash, identical metrics, identical artifactUri
```

**Expected:** distinct models → distinct content hashes → distinct results; CONTRACT §2.1 back-fill corrects the placeholder.
**Actual (observed):** both sims → `content_hash=ef40f5b9…`, both metrics `site_eui=151.4`, both `artifactUri=s3://results/ef40f5b9…/`. 11 unrelated no-sha sims shared one results row in the live DB. The second model to run silently returns the first model's energy figures (or overwrites them).

**Impact:** Researchers who don't pre-hash inputs (the SDK makes hashing *optional*, and the bare-string `ArtifactRef("s3://…")` path sends no sha) get **wrong simulation results** with no error. This defeats G5 (reproducibility) and is a correctness/data-integrity failure, not just "surprising".

**Suggested fix:** In `loop.py`, recompute `ch` from the (possibly back-filled) real shas whenever the SDK didn't supply both digests, rather than trusting `sim["content_hash"]`. Equivalently, have the API store `content_hash = NULL` when digests are absent so `sim.get("content_hash")` is falsy.

---

## High

### H-1 — Async batch (>100 variants) never transitions to `done`

**Component:** `internal/store/store.go:322` (`SetBatchTotals`) racing `db/migrations/*` trigger `app.sync_batch_counts`.

The async expander (`ExpandAsync`) inserts rows in a goroutine while runners are *already* draining the queue. The per-sim trigger recomputes `succeeded`/`state` correctly on each completion. Then the expander calls `SetBatchTotals(total, succeeded@expansion_time, 'queued')`, a plain `UPDATE app.batches SET total=…, succeeded=…, state=…` that **clobbers** the trigger's freshly-recomputed `succeeded` with a stale snapshot. The final sim's trigger fires in a window where its recompute is lost, and since all sims are then terminal, nothing re-fires to repair it. The batch is left `state='running'`, `succeeded = total-1` (or `-2`), forever.

**Repro:** `bash qa/05_async_batch.sh` (or submit a 130-variant batch with unique shas, wait for all sims terminal, then compare).
```
trial 1: batch=[running|succ=129|total=130]  actual_sims=[130/130]
trial 2: batch=[running|succ=129|total=130]  actual_sims=[130/130]
trial 3: batch=[running|succ=128|total=130]  actual_sims=[130/130]
```
Reproduced 4/4 across two sessions.

**Expected:** batch → `state='done'`, `succeeded=130`.
**Actual:** stuck `running`, `succeeded` short by 1–2. `SynergyClient`/UI polling `get_batch` for `done` never returns.

**Suggested fix:** `SetBatchTotals` should only set `total` and the *initial* state, recomputing `succeeded`/`failed` from `app.simulations` (like the trigger does) under the same lock, OR transition `expanding→queued` without writing counts and let the trigger own all counts. Add a defensive reaper that re-syncs batches whose sims are all terminal.

### H-2 — Per-user concurrency cap can be exceeded under load (TOCTOU race)

**Component:** CONTRACT §2.2 claim query (`runner/synergy_runner/db.py:37`).

The cap predicate `(SELECT count(*) … r.state='running') < per_user_cap` counts running rows that are **not locked** by the current claim. `FOR UPDATE SKIP LOCKED` only locks the single candidate row, so N runners can each read `count < cap` simultaneously and all claim, transiently overshooting the cap by up to N−1.

**Repro:** `CAP=2 NSLOW=10 NSIMS=40 bash qa/04_usercap.sh`
```
trial 1: PEAK concurrent running for user = 3 (cap=2)   ← FAIL
trial 2: PEAK concurrent running for user = 2 (cap=2)   ← pass
```
Intermittent (race), reproduced cap=2→peak 3 with 10 runners.

**Expected:** running ≤ cap at all times (G6 fairness).
**Actual:** running briefly exceeds cap; overshoot grows with runner count.

**Note:** cap=3 with 6 runners held at 3 in the lighter test; the overshoot needs enough concurrent claimants. Not unbounded, but the cap is advisory, not a hard ceiling. ADR-0003's deferred `claim_epoch`/fence does not address this; a serialized count (advisory lock per user, or `SELECT … FOR UPDATE` over the user's running set) would.

---

## Medium

### M-1 — Unknown `engineVersion` is accepted and queues forever

**Component:** `internal/api/handlers.go:51` (validation).

Submitting `engineVersion:"99.9.9"` returns `201 {state:"queued"}`. No RunnerPool serves it, so no runner ever claims it. The sim sits `queued` indefinitely with no error, no timeout, and counts against nothing. A typo'd version is an invisible black hole.

**Repro:**
```bash
curl -s -H "Authorization: Bearer synergy-dev-key" -X POST localhost:8090/v1/simulations \
  -d '{"engineVersion":"99.9.9","model":{"ref":"s3://models/sample/baseline.idf"},"weather":{"ref":"s3://weather/sample/chicago.epw"}}'
# → 201 queued; psql shows it queued forever
```
**Expected:** 400 (unknown version) or a queue-age timeout → `failed`.
**Actual:** 201, queued forever. Suggest validating against known RunnerPools/versions, or a "no eligible runner after T" reaper that fails the row.

### M-2 — `extractionSpec` is accepted and stored but silently ignored

**Component:** `runner/synergy_runner/loop.py` / `metrics.py` (never reads `sim["extraction_spec"]`).

CONTRACT §5: "Optional `extraction_spec` adds more." The API stores it on the sim row, but no runner code references it. Only the 7 core metrics are ever produced.

**Repro:** submit with `"extractionSpec":{"extra":["zone_air_temp","custom_metric_xyz"]}` → row has the spec, but `GET /v1/results` returns only the 7 core keys; `custom_metric_xyz` absent.
**Expected:** extra metrics extracted (or at least documented as unimplemented).
**Actual:** silent no-op. A documented feature does nothing.

### M-3 — Cross-user idempotency key collision returns HTTP 500

**Component:** `db/migrations/0001_init.sql` (`idempotency_key text UNIQUE`, global) vs `internal/store/store.go:305` (`FindBatchByIdempotencyKey` scoped `WHERE user_id=$1 AND idempotency_key=$2`).

If user A submits a batch with `idempotencyKey:"nightly"`, then user B submits with the same key, B's per-user lookup misses, `CreateBatch` hits the **global** unique violation, the fallback re-fetch also misses (scoped to B), and the handler returns `500 "could not create batch"`.

**Repro:** `qa/06_idempotency_xuser.sh` (creates a 2nd user `qa2@nus.edu.sg` + key, submits same key from both).
```
user A: {"batchId":"…","state":"expanding"}
user B: {"error":"could not create batch"}  [HTTP 500]
```
**Expected:** B gets its own batch (keys scoped per user) — or a clean 409.
**Actual:** 500. Also a minor info-leak: B can detect A used a given key. Fix: constraint `UNIQUE(user_id, idempotency_key)`.

### M-4 — `finish_simulation` is not fenced on `runner_id` (duplicate/zombie writer can clobber)

**Component:** `runner/synergy_runner/db.py:169`.

`heartbeat` correctly fences (`WHERE id=… AND runner_id=…`), but `finish_simulation` updates `WHERE id=…` only. After the reaper requeues a partitioned runner A's sim and runner B claims+finishes it, a late-waking A will overwrite B's terminal row (state/error/finished_at) with A's own result. ADR-0003 argues this is "harmless because results are input-keyed" — but combined with **C-1** (placeholder hash) or a differing verdict, A can flip a `succeeded` row to `failed` or overwrite metrics. The deferred `claim_epoch` fence (ADR-0003) is exactly the missing guard.

**Repro (mechanism):** reviewed in source; the QA-2 reaper test shows the requeue/re-run path that creates the two competing writers. Not yet observed flipping a verdict because the fake engine is deterministic-clean (see L-2).
**Suggested fix:** add `AND runner_id=$me` (or a `claim_epoch` fence) to `finish_simulation`'s WHERE.

---

## Low

### L-1 — Retention TTL (`artifact_expires_at`) never set; no GC (ADR-0008)
`upsert_result` never writes `artifact_expires_at` (0/1035 rows have it). No prune/GC code exists anywhere. Raw artifacts are kept forever. Documented as Phase-4, but the column is currently dead and storage grows unbounded.

### L-2 — Severe/Fatal/Warning verdict paths are UNTESTED end-to-end
The fake engine (`engine.py:_FAKE_ERR`) always writes a clean `.err`; all 1035 results in the DB are `verdict='clean'`. The `classify()` logic and the `succeeded`-vs-`failed` mapping (sim `failed` when verdict ∈ {severe,fatal}, batch `failed` count, error surfacing) have **never executed** in this deployment. Suggest a `SP_FAKE_VERDICT=severe|fatal` knob (or a fixture `.err`) so the failure path is demoable. Without it, the failed-run UX is unverified.

### L-3 — Bogus `s3://` refs "succeed" in fake mode
Submitting `model.ref:"x"` (not a real object) returns 201 and the runner, in fake mode, tolerates the missing object with a placeholder and marks the sim **succeeded** with synthetic metrics (`loop.py:_fetch_input`). Convenient for the demo, but means invalid input is indistinguishable from valid. Real-engine mode would fail; flag that fake mode masks input errors.

### L-4 — `priority` accepted then silently clamped (no feedback)
`priority:999999` and `priority:-5` both return 201; the server clamps to {0,2} (`normalizePriority`). Clamping is reasonable, but the client gets no signal that its value was altered. Minor DX papercut; consider 400 on out-of-range, or echo the effective priority.

---

## What works well

- **No double-claims under concurrency.** 30 unique sims across 6 runners: each ran exactly once (`attempts=1` for all), evenly distributed, zero shared-hash collisions. `FOR UPDATE SKIP LOCKED` is correct. (`qa/01_concurrency.sh`)
- **Reaper / lease / heartbeat.** Killing a running runner mid-sim → lease expired (~lease seconds), reaper requeued (`attempts++`), another runner finished it `succeeded`. Healthy long runs are *not* reaped (heartbeat renews). Retry exhaustion (attempts≥max) → `failed`, `error='lease expired'`, `finished_at` set. (`qa/02_reaper.sh`)
- **Cache (with sha256).** Same inputs+sha twice → 2nd is an immediate cache hit (`succeeded`, `attempts=0`, never started), exactly 1 `app.results` row, artifacts in `s3://results/<hash>/`. No-sha correctly does *not* cache-hit at submit (though see C-1 for the back-fill bug). (`qa/03_cache.sh`)
- **Auth.** Missing key → 401, malformed (no `Bearer`) → 401, wrong key → 401, revoked key → 401, valid → 201. Revoke takes effect immediately. (CONTRACT §3)
- **Per-user cap holds for moderate fan-out** (cap=3 / 6 runners held at 3). It's only the high-contention TOCTOU (H-2) that overshoots.
- **Validation basics.** Malformed JSON → 400, missing required fields → 400, priority clamped server-side.
- **Idempotency (same user).** Same `idempotencyKey` → same `batchId`, no duplicate batch. Concurrent-submit fallback path exists.
- **Async expansion mechanics.** 150-variant batch returned `202 expanding`, expanded in background, drained — only the *rollup* (H-1) is broken; the sims themselves all ran.
- **Portal DX is genuinely good.** Domain allow-list rejects `@gmail.com` server-side (Better Auth `before` hook, not just client JS) and accepts `@nus.edu.sg`/`@urbanflow.co`. Dev magic-link is surfaced in logs *and* via `/api/dev/last-link?email=`. Full flow verified: login → user upserted to `app.users` → mint `sp_live_…` key → key works against API (201) → revoke via portal → 401. Clear copy-paste docs.
- **Data integrity (sha path).** 1051/1051 ran-sims have `started_at`+`finished_at`; 1035/1035 results have all 7 core metric keys (none null) and `artifact_uri`; metrics plausible.

---

## Coverage summary

| Area | Tested | Result |
|---|---|---|
| Concurrency / no double-claim (30 sims, 6 runners) | ✅ | PASS |
| Reaper requeue on dead runner | ✅ | PASS |
| Heartbeat keeps healthy run alive | ✅ | PASS |
| Retry exhaustion → failed | ✅ | PASS |
| Cache hit with sha256 | ✅ | PASS |
| Cache: no-sha back-fill correctness | ✅ | **FAIL (C-1)** |
| Per-user cap (moderate) | ✅ | PASS |
| Per-user cap (high contention) | ✅ | **FAIL (H-2)** |
| Auth: missing/malformed/wrong/revoked/valid | ✅ | PASS |
| Validation: bad JSON, missing fields, priority | ✅ | PASS |
| Unknown engineVersion | ✅ | **FAIL (M-1)** |
| Batch >100 async expansion | ✅ | partial — sims run, rollup **FAIL (H-1)** |
| Idempotency same-user | ✅ | PASS |
| Idempotency cross-user | ✅ | **FAIL (M-3)** |
| extractionSpec honored | ✅ | **FAIL (M-2)** |
| Portal domain + magic-link + key lifecycle | ✅ | PASS |
| Data integrity (metrics/artifacts/timestamps) | ✅ | PASS (sha path) |
| Verdict severe/fatal/warnings e2e | ⚠️ | **NOT TESTABLE** with fake engine (L-2) |
| Real EnergyPlus engine | ❌ | Not run (fake mode only; out of scope for Compose demo) |
| `finish_simulation` fence race (live) | ⚠️ | Reviewed in source (M-4); not forced live |
| KEDA / operator / k8s scaling | ❌ | Not exercised (Compose path only) |
| Retention/GC | ✅ | Unimplemented (L-1) |

### Couldn't / didn't test
- **Real `nrel/energyplus`** engine and real `.sql` metric extraction (Compose runs fake mode).
- **KEDA eligible-depth scaler / operator / RunnerPool CRD** (k8s-only, not in Compose).
- **Non-clean verdicts e2e** — no way to make the fake engine emit Severe/Fatal (L-2). Recommend a `SP_FAKE_VERDICT` env so QA can drive the failure path.
- **Forcing M-4 live** — would need to delay runner A's `finish_simulation` while B completes (e.g. a debug sleep); left as source-level finding.
