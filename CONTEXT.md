# SynergyPlus

The domain language for SynergyPlus — a Kubernetes-native orchestrator that queues
and runs EnergyPlus simulations across on-prem and cloud capacity.

## Language

**Simulation**:
A single EnergyPlus run of one model against one weather file, producing one result.
_Avoid_: job, task, run

**Batch**:
A parametric set of Simulations that share configuration, submitted and tracked as
one unit.
_Avoid_: sweep, job-array

**Runner**:
A long-lived worker pod that pulls Simulations from the Run Queue and executes the
EnergyPlus engine. A pool of Runners is scaled dynamically to drain the queue.
_Avoid_: worker, executor, agent
_Note_: the `worker/` package predates this term; it is the code a Runner executes
and should be aligned to "Runner" over time.

**RunnerPool**:
The declarative, per-Engine-Version unit of capacity: the set of Runners for one
version, deployed and scaled together. One pool per supported version; each scales
independently (to zero by default) against its own eligible queue depth. The pool's
configuration is policy (which version, bounds, resources); the live size is driven
by the queue, not by editing the configuration.
_Avoid_: fleet, worker group, SimulationRunner

**Run Queue**:
The ordered set of Simulations that have been admitted but not yet claimed by a
Runner. Concurrency limits gate how many move from queued to running.
_Avoid_: backlog, pending pool

**Claim**:
A Runner taking exclusive ownership of a queued Simulation in order to execute it,
via a transactional Postgres update (`FOR UPDATE SKIP LOCKED`). Exactly one Runner
can hold a given Simulation at a time.
_Avoid_: lock, lease (lease is the *duration*, claim is the *act*), dequeue

**Lease**:
The time-bounded, heartbeat-renewable hold a Runner keeps on a claimed Simulation.
An expired Lease means the Runner is presumed dead and the Simulation is requeued.

**Reaper**:
The operator component that detects Simulations whose Lease has expired (Runner
presumed dead) and re-queues them, up to the retry limit.

**Content Hash**:
The identity of a Simulation's result, computed from its **inputs** (model + weather +
Engine Version + Runner image), never its outputs. Used both to deduplicate runs (the
result cache) and to make a re-executed Simulation idempotent.
_Avoid_: result hash, output hash (the hash is of inputs, deliberately)

**Expansion**:
The act of turning a submitted Batch into its individual queued Simulations,
resolving cache hits as it goes so already-computed variants skip the queue. Runs in
the background; a Batch is briefly *Expanding* before all its Simulations exist.
_Avoid_: fan-out, unrolling

**Result Cache**:
The store of completed results keyed by Content Hash. A Simulation whose Content Hash
is already present is satisfied from the cache without running.
_Avoid_: memo, dedup table

**Core Metrics**:
The fixed set of EnergyPlus outputs (site & source energy, EUI, unmet hours, peak
demand, run metadata) extracted from every Simulation into the permanent Result Index.
Never lost, even after raw artifacts are pruned.
_Avoid_: KPIs, summary stats

**Result Index**:
The queryable, permanent store of per-Simulation Core Metrics (and any study-specific
extracted values) plus pointers to the raw artifacts. Distinct from the Result Cache,
which is keyed by Content Hash to avoid re-running.
_Avoid_: results table

**Verdict**:
The success classification of a completed Simulation, derived from EnergyPlus's
`.err` file: `clean` | `warnings` | `severe` | `fatal`. Warnings still count as
success; severe and fatal do not.
_Avoid_: status (reserved for the lifecycle phase), outcome

**User**:
A researcher who submits and owns Simulations, identified by an email whose domain
is in the installation's configured allow-list (`ALLOWED_EMAIL_DOMAINS`) via the
in-cluster auth service. The unit of fairness and quota: per-User concurrency caps
and priority govern how their queued work is claimed. The lab has ~40 Users sharing
one installation.
_Avoid_: tenant, account, owner (the lab as a whole is not a User)

**Engine Version**:
The EnergyPlus release a Simulation runs on (e.g. `24.1.0`). A model is version-locked
to its Engine Version, which selects a version-matched Runner image.
