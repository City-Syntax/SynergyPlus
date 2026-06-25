# Postgres-backed Run Queue; the CR is the API surface, Postgres is the source of truth

The Run Queue lives in PostgreSQL and is drained with `SELECT … FOR UPDATE SKIP
LOCKED`, reusing the metadata DB rather than etcd or a dedicated broker. The
`Simulation` custom resource stays the **user-facing API surface** (what gets
submitted and read); **Postgres is the operational source of truth** for queue and
run state, and the operator mirrors run state back onto the CR's `status.phase`.

Status: accepted — refined by ADR-0006 (Simulations are database entities, not CRs;
the only custom resource is `RunnerPool`)

## Considered options

- **etcd / CRD-as-queue** — single source of truth, no new infra, but a poor
  high-throughput queue: ~100k pending objects pressures etcd, and many Runners
  racing to claim the same CR generate optimistic-concurrency contention.
- **External broker** (Redis Streams / NATS JetStream) — purpose-built queue
  semantics, but a new stateful component and a second source of truth to reconcile
  against Simulation state.

## Consequences

- The Simulation now has a dual representation (CR mirrors Postgres) that must be
  kept in sync; the operator owns that sync.
- The skeleton's Job-creating `SimulationReconciler` is superseded by an
  enqueue-and-sync operator plus pull-based Runners.
- Claim and result-index writes share one transaction, so the queue and the result
  index cannot disagree.
