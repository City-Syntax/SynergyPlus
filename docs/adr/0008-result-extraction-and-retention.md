# Always extract core metrics; TTL the raw artifacts (regenerable via Content Hash)

At completion, every Simulation has a **fixed core metric set** (site & source energy,
EUI, unmet heating/cooling hours, peak demand, run metadata) extracted into the
Postgres result index (JSONB) — permanent and queryable — plus an optional
**per-submission extraction spec** for study-specific outputs. The `.err` and run
summary are kept **forever** (tiny, diagnostic). Raw ESO/SQL artifacts sit behind a
**configurable TTL**: because results are content-hash-addressed, a pruned artifact is
regenerable by re-running the same inputs, so the TTL trades storage cost against
occasional recompute.

Status: accepted

## Considered options

- **Keep everything forever, fixed metrics** — simplest, but TB-scale per sweep, and a
  single fixed metric set frustrates studies needing other outputs, so people hoard raw
  artifacts anyway — the expensive outcome we're avoiding.
- **Fixed metric set only, no configurable extraction** — rejected: any uncaptured metric
  forces a full re-run.

## Consequences

- Extraction runs at completion in the Runner's post step, before raw artifacts become
  eligible for TTL pruning.
- The extraction spec is part of the submission contract.
- A core metric is never lost even after raw GC; a non-core metric needs either a prior
  extraction spec or a re-run.
