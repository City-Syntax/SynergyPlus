# At-least-once execution with input-keyed idempotent results

A Runner that is partitioned mid-run keeps computing while its Lease expires and the
reaper re-queues its Simulation, so the same Simulation can execute twice. We accept
**at-least-once execution** rather than pursue exactly-once, because a partitioned
process cannot be stopped — "exactly-once" is unachievable and collapses to
idempotency plus fencing. Correctness comes from keying every result on the **input
hash** (`model + weather + engine version + runner image`) so a duplicate run writes
the same result slot via upsert, making re-execution harmless.

Status: accepted

## Considered options

- **Fence token now** — reject writes from a superseded claim. Deferred: it is purely
  additive (one `claim_epoch` column + a `WHERE` clause), so it can be added later
  without redesign. Add it when expensive multi-hour cloud runs or observed status
  churn justify it.
- **Exactly-once execution** — rejected. Cannot prevent a partitioned process from
  computing; the achievable core is idempotency + fencing, already covered above.

## Consequences

- Results MUST be keyed on **inputs, not outputs** — EnergyPlus output is not
  byte-identical across runs (embedded timestamps), so output-keying would give two
  hashes for one logical result. This is the one decision that is costly to reverse.
- The Lease is heartbeat-renewable (tracks *liveness*, not a fixed duration) to span
  the seconds-to-hours range of EnergyPlus run times.
- Expose a duplicate-rate signal (`executed_total` vs `completed_total`) so an
  over-aggressive reaper is visible.
