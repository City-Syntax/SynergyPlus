# Per-User concurrency caps for fairness, in a single shared namespace

The deployment serves one lab of ~40 researchers, so the unit of fairness is the
individual **User** (researcher), not a lab/tenant. Fairness is enforced by a
per-User concurrent-run cap combined with the existing per-Simulation priority
tiers, both expressed in the claim query: exclude Users already at their cap, then
order by priority and FIFO. All runs share **one Kubernetes namespace**; User
identity is a column stamped at submission, not a namespace boundary.

Status: accepted

## Considered options

- **Namespace-per-tenant + ResourceQuota** (the proposal's Phase-3 model) — rejected:
  ~40 namespaces is operational overhead with no benefit inside one trusting lab.
- **Weighted fair-share / DRF** (e.g. a funded project gets 3× the share) — deferred:
  strictly heavier, and it layers on the same per-User running-count bookkeeping if
  flat caps later prove unfair.

## Consequences

- A **global cap** still bounds total concurrency (and spend); the **per-User cap**
  bounds any one researcher's footprint; both read the same running-count state.
- Auth must establish User identity (OIDC) so the API can stamp `user_id` at submit
  time. This is the one piece of multi-tenant machinery we keep from day one.
- Per-Batch `maxParallelism` is the same capping pattern applied per-Batch.
