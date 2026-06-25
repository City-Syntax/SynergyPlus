# RunnerPool is the only CRD; work items are database entities

The single custom resource is **`RunnerPool`** — a declarative, per-Engine-Version
capacity object (image, version, resources, floor `minReplicas`, ceiling
`maxReplicas`, scaling trigger, default caps). The operator reconciles each
`RunnerPool` into a Deployment + a KEDA ScaledObject. **Simulations and Batches are
database entities** submitted via the API/SDK — never custom resources — and
Kubernetes `Job` objects are not used at all (Runners are long-lived Deployment
pods). Declarative *capacity* lives in etcd where it is cheap; the high-volume
*workload* lives in Postgres.

Status: accepted — refines ADR-0002 and supersedes the skeleton's `Simulation` /
`SimulationBatch` CRDs and its Job-per-run model.

## Considered options

- **Simulation/Batch as CRDs** (the skeleton) — rejected: up to 100k etcd objects per
  Batch plus a per-row sync loop, the exact problem ADR-0002 moved the queue to
  Postgres to avoid.
- **Batch-only CRD** (option C) — gives declarative `kubectl apply` batch submission,
  but adds a CR↔Postgres sync path for marginal benefit to an SDK-driven lab.
  Deferred; a thin Batch CRD can be added later if GitOps submission is wanted.
- **Auto-provisioning RunnerPools from queued versions** — rejected: letting an
  arbitrary submitted `engineVersion` conjure a pool means a submission can pull and
  run an unvetted image. A declarative allow-list + scale-to-zero gives idle-cost-free
  pools without the trust hole.

## Consequences

- The `RunnerPool` **spec** stays low-churn (policy/bounds only). KEDA drives the
  replica count from the queue *within* those bounds and writes it to the Deployment —
  the spec must never be rewritten per queue event, or etcd write-churn returns.
- Adding or retiring an EnergyPlus version is a declarative `kubectl apply`/`delete`
  of a `RunnerPool` — supported versions become GitOps-managed.
- The skeleton's `api/v1` Simulation & SimulationBatch types, both reconcilers, and the
  Job-building code are superseded by: a `RunnerPool` type + reconciler, and a
  Postgres-backed submission/queue API.
