# Make the RunnerPool CR the real single source for Engine Version & cap

The RunnerPool custom resource is already meant to be the single declarative
source for an Engine Version and its per-User cap (ADR-0006). Close the gap so the
Runner image tag and the KEDA query **derive** from the CR instead of re-stating
the same literals across ~8 manifests.

Status: proposed

## Context

`24.1.0` appears in ~8 configuration sites — `config/samples/runnerpool.yaml:7,8`
(spec + image tag), `config/keda/scaledobject.yaml:29`,
`deploy/docker-compose.yml:61,105`, `deploy/k8s-local/runnerpool-demo.yaml:10,11`,
`deploy/k8s-local/secret.yaml:21`. The per-User cap `50` appears in ~7 (see
ADR-0011). These values are coupled — the image tag must track `engineVersion`;
the KEDA literal must track `defaultUserConcurrency` — but nothing enforces the
coupling. Bumping a version is an error-prone, multi-file checklist.

ADR-0006 already designates the RunnerPool CR as the only CRD and the unit of
per-version capacity. The leak is that two derived values (image tag, KEDA query)
are typed by hand rather than computed from the spec.

## Decision

- The operator already templates the KEDA `ScaledObject` from the spec
  (`internal/controller/runnerpool_controller.go:158-197`); fold the cap into
  ADR-0011's eligibility function so the KEDA literal disappears entirely.
- Derive the Runner image tag from `spec.engineVersion` (a convention or a
  defaulting webhook) so version is stated once on the CR.
- Treat the remaining deploy-manifest duplication (`docker-compose`, `secret.yaml`
  envs) as a Kustomize/Helm single-value concern, not application logic.

This candidate is **partly subsumed by ADR-0011**: once the eligibility predicate
owns the cap, the most dangerous duplication (the KEDA `< 50`) is already gone.

## Considered options

- **Derive from the CR (preferred)** — image tag and KEDA cap computed from
  `spec`; honours ADR-0006's intent.
- **A single Kustomize value** feeding all manifests — addresses deploy sprawl but
  not the in-operator derivation.
- **Status quo** — version bumps stay a checklist; acceptable only because the set
  of versions changes rarely.

## Consequences

- **Locality:** Engine Version and cap are declared once, on the CR.
- **Leverage:** version bumps become a one-line spec change.
- Lower urgency than ADR-0011–0013: the remaining duplication is mostly
  deploy-manifest sprawl, not a module-depth problem. Sequence it last, after the
  cap concern is absorbed by ADR-0011.
