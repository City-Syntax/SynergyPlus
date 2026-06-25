# Worker-pool execution model instead of one Job per Simulation

A parametric Batch can reach 100k+ EnergyPlus runs, and many runs are very short
(seconds), so a 1:1 Kubernetes Job/Pod per Simulation would impose pod-startup
latency and an etcd/API-server object on every run. We will instead execute
Simulations on a **dynamically-scaled pool of long-lived Runner pods that pull
work from a Run Queue**, with explicit concurrency limits.

Status: accepted

## Considered options

- **One Job per Simulation** (the original skeleton). K8s-native and gives isolation,
  retries, and scheduling for free — but the per-run pod startup and per-run object
  count become the bottleneck at Batch scale. Rejected for that reason.

## Consequences

- We now own what Jobs gave us for free: a queue, concurrency control, and
  at-least-once claim semantics. Runner crashes must re-queue in-flight Simulations.
- Engine Version is pinned by selecting a version-matched Runner image; a Runner
  pool is therefore (at least) per-supported-version.
