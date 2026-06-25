# SynergyPlus — System Architecture Proposal

**A Kubernetes-native orchestrator for distributed EnergyPlus simulations**

| | |
|---|---|
| **Status** | Draft v0.2 |
| **Date** | 2026-06-25 |
| **Audience** | Engineering, lab IT, building-science researchers |

> **v0.2 note.** This revision incorporates the design decisions in
> [`docs/adr/0001`–`0009`](./adr/). The architecture has changed substantially from
> v0.1: simulations are no longer Kubernetes objects, there are no per-run Jobs, the
> queue lives in Postgres, and the only custom resource is `RunnerPool`. See
> [§12](#12-reconciling-the-skeleton) for what this means for the existing code.

---

## 1. Summary

SynergyPlus lets a building-science lab **queue, run, and collect EnergyPlus
simulations at scale**, on-prem or burst to cloud, from one API. A researcher submits
a model (or a parametric *Batch* of thousands of variants); SynergyPlus queues the
work, runs it on a dynamically-scaled pool of workers, retries failures, caches
results, and indexes the metrics — without anyone hand-managing a single run.

The shape of the system follows from two facts: EnergyPlus runs are **embarrassingly
parallel** (independent, CPU-bound, version-locked processes), and a parametric sweep
can be **very large** (up to ~100k runs). So the design optimizes for throughput and
queue fairness, deliberately keeps the high-volume workload **out of etcd**, and uses
Kubernetes for what it is good at — running and autoscaling a pool of workers.

---

## 2. Background

[EnergyPlus](https://energyplus.net/) is the U.S. DOE's open-source whole-building
energy engine. The traits that shape this system:

- **CLI engine.** `energyplus -w weather.epw -d out/ model.idf`. Containerizes cleanly.
- **Single-threaded, CPU-bound.** ~1 core/run; modest memory; wall-clock from seconds
  (shoebox models) to hours (detailed sub-hourly annual runs).
- **Version-locked.** A model authored for 24.1 runs on the 24.1 binary. Labs keep
  several versions alive → **one immutable Runner image per version**.
- **Well-defined I/O.** In: an `IDF`/`epJSON` model + an `EPW` weather file. Out:
  `ESO`/`SQL`/`CSV`/`HTML` plus an `ERR` whose `Severe`/`Fatal` markers define success.

Labs run these as sweeps — calibration, sensitivity, optimization — today by hand on
workstations or shared HPC nodes: serial, fragile, no queue, results scattered.

---

## 3. Goals & non-goals

### Goals
- **G1** Single submission API for one run or a parametric Batch of many.
- **G2** Version-correct execution (pinned EnergyPlus per run).
- **G3** Elastic, queue-driven scale; scale-to-zero when idle; cloud-burst later.
- **G4** Reliability: at-least-once execution, automatic retries, no lost results.
- **G5** Reproducibility: identical inputs → one content-addressed, cacheable result.
- **G6** Fairness across the lab's ~40 researchers (per-User caps + priority).
- **G7** Observability: queue depth, throughput, per-User utilization, failures, cost.

### Non-goals (v1)
- Authoring/editing models (OpenStudio/Eppy stay upstream).
- A parametric *design* engine (calibration/optimization loops). We run the variants a
  sweep produces; an external optimizer can drive us via the API.
- Namespace-per-tenant multi-tenancy — one lab, one namespace, fairness by `user_id`
  ([ADR-0004](./adr/0004-per-user-fairness-single-namespace.md)).

---

## 4. Personas & flagship use case

| Persona | Need |
|---|---|
| **Researcher** | "Run these 5,000 IDF variants against this EPW; tell me which fail; give me annual energy per variant." |
| **Lab admin** | "Cap total concurrency/spend; give funded projects higher priority." |
| **Platform/IT** | "Run on our cluster, keep data on our MinIO, scale workers to the queue." |

**Flagship — a parametric sweep:** a researcher submits one Batch (base model +
weather + a parameter set). SynergyPlus expands it into independent Simulations,
resolves cache hits, queues the rest, scales worker pools to drain the queue, retries
transient failures, and presents one Batch view with per-run status + Core Metrics.

---

## 5. Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │   USERS:  CLI · Python SDK · Developer Portal  │
                       └───────────────┬───────────────────────────────┘
                          API key (minted in portal) │  email-domain login
┌─────────────────────────────────────▼──────────────────────────────────────────┐
│ CONTROL PLANE  (namespace: synergy-system)                                       │
│                                                                                  │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────────────────────┐ │
│  │ Better Auth │   │ API Gateway  │   │ Operator                              │ │
│  │ + Portal    │──▶│ (Go)         │   │  • RunnerPool reconciler → Deployment │ │
│  │ (TS, pod)   │   │ validate key │   │      + KEDA ScaledObject              │ │
│  │ domain      │   │ → user_id    │   │  • Reaper (expired Leases → requeue)  │ │
│  │ allow-list  │   │ submit/query │   │  • Batch Expander (→ queue rows)      │ │
│  └──────┬──────┘   └──────┬───────┘   └───────────────────┬───────────────────┘ │
│         │                 │  writes / reads               │ reconciles           │
│         ▼                 ▼                               ▼                       │
│  ┌──────────────────────────────────────────┐   ┌──────────────────────────────┐│
│  │ POSTGRES  (single source of truth)        │   │ Kubernetes API               ││
│  │  • run queue (FOR UPDATE SKIP LOCKED)     │   │  RunnerPool (the only CRD)   ││
│  │  • result index (Core Metrics)            │   │  → per-version Deployments   ││
│  │  • result cache (by Content Hash)         │   │  → KEDA ScaledObjects        ││
│  │  • users / API keys (auth schema)         │   └───────────────┬──────────────┘│
│  └───────────────────────▲──────────────────┘                   │ scales         │
└──────────────────────────│──────────────────────────────────────│────────────────┘
              claim / heartbeat / write result    ┌────────────────▼───────────────┐
                           │                       │ RUNNER POOLS (one per version) │
                           └───────────────────────│  energyplus-runner:24.1.0 …    │
                                                   │  each Runner loops:            │
                                                   │   claim → fetch → run →        │
                                                   │   parse .err → extract → upload│
                                                   └────────────────┬───────────────┘
                                                                    ▼
                                          ┌───────────────────────────────────────┐
                                          │ OBJECT STORAGE (MinIO / S3)            │
                                          │ models · weather cache · raw artifacts │
                                          └───────────────────────────────────────┘

   KEDA scales each pool on its *eligible* (cap-aware) queue depth, 0 → ceiling.
   Cluster Autoscaler / Karpenter (later) adds nodes / cloud-burst for unschedulable Runners.
```

The pivotal idea: **Kubernetes runs the workers; Postgres runs the work.** Capacity is
declarative (a `RunnerPool` CR per version); the workload is transactional data
(queue + index + cache rows). This keeps ~100k-run Batches out of etcd while keeping
the snappy, GitOps-friendly parts (which versions exist, how they scale) in Kubernetes.

---

## 6. Components

### 6.1 API Gateway (Go)
REST + gRPC. Validates the presented **API key** (hashed-key lookup in Postgres →
`user_id`), enforces per-User quota, accepts submissions, and serves status/results.
Submission is **idempotent** on a client key. Stateless; scales horizontally.

### 6.2 Better Auth + Developer Portal (TypeScript, in-cluster)
Self-hosted auth ([ADR-0009](./adr/0009-better-auth-with-domain-allowlist-and-api-key-portal.md)).
Login restricted to `@urbanflow.co` / `@nus.edu.sg`. A small portal lets a logged-in
User mint/revoke API keys (the credential the SDK/CLI carry). Backed by the shared
Postgres (separate schema). Swappable to OIDC federation later.

### 6.3 Operator (Go, controller-runtime)
Reconciles the **only CRD, `RunnerPool`** ([ADR-0006](./adr/0006-runnerpool-is-the-only-crd.md)),
and owns two background loops:
- **RunnerPool reconciler** — a `RunnerPool` (per Engine Version) → a Deployment of
  Runners + a KEDA ScaledObject. Adding/retiring a version is `kubectl apply/delete`.
- **Reaper** — re-queues Simulations whose Lease has expired (dead Runner), up to the
  retry limit ([ADR-0003](./adr/0003-at-least-once-with-idempotent-results.md)).
- **Batch Expander** — turns an accepted Batch into queue rows in chunks, resolving the
  cache as it goes ([ADR-0007](./adr/0007-async-batch-expansion-cache-at-expansion.md)).

### 6.4 Runner (the pull-loop worker; Python engine logic)
A long-lived pod in a per-version pool. Loop: **Claim** a Simulation
(`SELECT … FOR UPDATE SKIP LOCKED`, cap-aware), **fetch** model + weather (weather from
a shared cache), **run** EnergyPlus, **parse** the `.err` → Verdict, **extract** Core
Metrics + any study-specific outputs, **upload** raw artifacts, **write** the result +
index row. Heartbeats to renew its Lease while running (liveness, not a fixed timeout),
so seconds-to-hours runs are both supported and reaped-when-dead.

### 6.5 Postgres (single source of truth)
A **single instance** ([ADR-0010](./adr/0010-single-postgres-instance.md)) holding the
run queue, the result index (Core Metrics, permanent), the result cache (by Content
Hash), and the auth schema — each in its own schema. Claims and result writes share one
transaction, so queue and index never disagree ([ADR-0002](./adr/0002-postgres-backed-run-queue.md)).
The API gateway validates API keys by local hashed-key lookup here.

### 6.6 Object storage (MinIO on-prem / S3)
Models, the EPW weather cache, and raw artifacts. `.err` + summary kept forever; raw
ESO/SQL behind a configurable TTL — pruned artifacts are regenerable from the Content
Hash ([ADR-0008](./adr/0008-result-extraction-and-retention.md)).

### 6.7 Scaling (KEDA; Karpenter later)
KEDA scales each pool on its **eligible** (cap-aware) queue depth, 0 → ceiling, with a
configurable warm floor ([ADR-0005](./adr/0005-per-version-keda-scaling.md)). Node-level
cloud-burst is a separate, later layer.

---

## 7. Data model

### 7.1 The one CRD — `RunnerPool`
```yaml
apiVersion: synergyplus.io/v1
kind: RunnerPool
metadata: { name: eplus-24-1-0, namespace: synergy-system }
spec:
  engineVersion: "24.1.0"
  image: ghcr.io/synergyplus/energyplus-runner:24.1.0
  resources: { cpu: "1", memory: "2Gi" }
  minReplicas: 0          # scale-to-zero default; raise the floor if first-run latency bites
  maxReplicas: 200        # ceiling
  defaultUserConcurrency: 50
status:
  readyReplicas: 0
  eligibleQueued: 0       # surfaced on a throttled interval, never per queue event
```
The **spec is low-churn policy**; KEDA moves the live replica count *within* these
bounds from the queue — the spec is never rewritten per queue event.

### 7.2 Postgres (core tables, abbreviated)
- **`users`**, **`api_keys`** — Better Auth schema; `api_keys` holds hashed keys → `user_id`.
- **`batches`** — `id`, `user_id`, `state` (`expanding|queued|running|done`), counts, idempotency key.
- **`simulations`** — the queue *and* the run record: `id`, `batch_id`, `user_id`,
  `engine_version`, `priority`, `model_ref`, `weather_ref`, `content_hash`,
  `state` (`queued|running|succeeded|failed`), `runner_id`, `lease_expires_at`, `attempts`.
- **`results`** — `content_hash` (PK, upsert), `metrics` JSONB (Core Metrics), `verdict`,
  `artifact_uri`, `artifact_expires_at`.

The **claim query** picks the highest-priority, oldest `queued` Simulation among Users
under their concurrency cap, via `FOR UPDATE SKIP LOCKED`. The KEDA trigger query uses
the **same eligibility predicate** so scaler and claimer agree.

---

## 8. Lifecycle of a Batch

```
submit Batch ─▶ API: validate key→user_id, quota, idempotency ─▶ batches row (state=expanding)
   └▶ Expander (chunked):  for each variant → content_hash
        ├─ cache hit  → write succeeded simulation linked to existing result   (skips queue)
        └─ cache miss → insert queued simulation row
   batches.state → queued
        └▶ Runner (per-version pool, scaled by KEDA on eligible depth):
             claim (SKIP LOCKED, cap-aware) → lease + heartbeat
               ├ fetch model+weather → run energyplus → parse .err (Verdict)
               ├ extract Core Metrics (+ study spec) → upload artifacts
               └ write results (upsert by content_hash) + simulation=succeeded
             transient failure (preempt/OOM/dead lease) ─▶ Reaper requeues (≤ retries)
                                                           └ exhausted ─▶ failed (+ .err surfaced)
```

---

## 9. Cross-cutting concerns

- **Reproducibility & cache (G5).** Content Hash = `sha256(model + weather + version +
  image)` — keyed on **inputs, not outputs** (EnergyPlus output isn't byte-identical).
  Identical inputs → one cached result; re-execution is idempotent (upsert).
- **Fairness (G6).** Per-User concurrency cap + priority + per-Batch `maxParallelism`, all
  expressed in the claim query. One namespace, `user_id` from auth.
- **At-least-once (G4).** A partitioned Runner can run a Simulation twice; that's safe
  because results are input-keyed and idempotent. A `claim_epoch` fence token is a
  deferred, additive guard for expensive long runs.
- **Security.** Domain-restricted login; hashed API keys; per-Runner scoped object-store
  creds; digest-pinned Runner images; audit log of submissions and result access.
- **Cost (G3).** Scale-to-zero idle pools; spot nodes on burst (later); per-User caps and
  a global cap bound spend; Grafana surfaces `$/run`.

---

## 10. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Operator / API | **Go** (controller-runtime, gRPC+REST) | Standard K8s + service tooling |
| Auth / portal | **Better Auth** (TypeScript, in-cluster) | Self-hosted, domain allow-list, API keys |
| Source of truth | **PostgreSQL** | Queue (SKIP LOCKED) + index + cache + auth, transactional |
| Worker scaling | **KEDA** (Karpenter later) | Queue-driven, scale-to-zero, per-version pools |
| Engine packaging | **Per-version OCI images, digest-pinned** | Version-lock + reproducibility |
| Object storage | **MinIO / S3** | One S3 API across on-prem & cloud |
| Observability | **Prometheus + Grafana + Loki** | Metrics, dashboards, logs |
| Runner engine logic / SDK | **Python** | Labs live in Python; reuse `.err`/SQL parsing |

Stack is **polyglot**: Go + Python + TypeScript ([ADR-0009](./adr/0009-better-auth-with-domain-allowlist-and-api-key-portal.md)).

---

## 11. Roadmap

- **Phase 1 — MVP.** `RunnerPool` CRD + reconciler; Postgres queue + claim loop; one
  Runner pool; API + Python SDK; core-metric extraction; single-run submit.
- **Phase 2 — Batches & cache.** Async Expander, content-hash cache, per-User fairness,
  KEDA scale-to-zero, Grafana dashboards.
- **Phase 3 — Auth & portal.** Better Auth, domain allow-list, developer portal, API keys.
- **Phase 4 — Hardening.** Retention/TTL GC, fence tokens if needed, cloud-burst nodes,
  SLOs, cost dashboards.

---

## 12. Reconciling the skeleton

The v0.1 skeleton was built before this grilling and now describes a system we've
decided **not** to build. Concretely:

**Remove / supersede**
- `api/v1/simulation_types.go`, `simulationbatch_types.go` — Simulations and Batches are
  **Postgres rows, not CRDs** ([ADR-0006](./adr/0006-runnerpool-is-the-only-crd.md)).
- `internal/controller/simulation_controller.go`, `simulationbatch_controller.go` — the
  Job-creating reconcilers; there are **no per-run Jobs** ([ADR-0001](./adr/0001-worker-pool-execution-model.md)).
- `config/crd/synergyplus.io_simulations*.yaml`, `config/samples/*` — the old CRDs.
- The apiserver's CR-creating handlers — submissions write to **Postgres**, not the K8s API.

**Add**
- `RunnerPool` CRD + reconciler (→ Deployment + KEDA ScaledObject).
- Postgres schema + migrations (queue, index, cache, auth) and the claim/heartbeat SQL.
- API submission path (idempotent, key-validated) + the Batch Expander + the Reaper.
- Runner **pull-loop** wrapping the existing fetch/run/`.err`-parse logic (which survives
  largely intact in `worker/`), plus Lease heartbeating and metric extraction.
- Better Auth service + developer portal (TypeScript).
- KEDA install + per-pool ScaledObject templating.

**Survives mostly intact**
- `worker/synergy_worker/` — fetch, `parse_err`, storage shim. The classifier and the
  run/parse/upload steps move *inside* the Runner's claim loop rather than a one-shot Job.
- The Python SDK shape (`submit / get / wait`), now talking to the Postgres-backed API.

---

## 13. Open questions

- **Retention defaults** — concrete TTL and the GC trigger (age vs. storage pressure).
- **Optimizer hook** — webhook/callback so an external calibration loop can submit the
  next generation from Batch results (post-v1).
