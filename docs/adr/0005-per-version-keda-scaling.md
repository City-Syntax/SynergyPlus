# Per-version KEDA scaling on eligible queue depth, scale-to-zero with a configurable floor

Each supported Engine Version has its own Runner `Deployment`, scaled by **KEDA**
off a Postgres trigger that counts only **claimable** queued Simulations for that
version — applying the same per-User / global cap logic as the claim query, not raw
queue depth. Pools **scale to zero** by default; a per-version warm-floor is a
configurable knob (default `0`) to turn up if interactive first-run latency matters.

Status: accepted

## Considered options

- **Scale on raw queue depth** — rejected: over-cap work isn't claimable, so the
  scaler would spin up Runners that immediately idle, blocked by per-User caps.
- **A single shared Runner pool** — rejected: a Runner image *is* a specific Engine
  Version, so pools are necessarily per-version.
- **Warm floor everywhere** — deferred behind the floor knob; snappier first run but
  holds idle capacity for versions nobody may use that day.

## Consequences

- A cold version pays a multi-GB image pull + pod start (~30–90s) on its first run.
  Mitigate by pre-pulling active-version images onto nodes (DaemonSet / node cache).
- The KEDA trigger query and the claim query MUST share one eligibility definition,
  or the scaler and the claimer disagree.
- Cloud-burst is *node* autoscaling (Karpenter reacting to unschedulable Runners), a
  separate and later layer from this *pod* scaling.
