# Give the Claim eligibility predicate a single home

The rule that decides which queued Simulation a Runner may **Claim** — the
per-User fairness predicate `count(running for user) < cap`, gated by Engine
Version — should live in **one place** (a Postgres function, e.g.
`app.eligible_simulations(version, cap)`), consumed by every runtime instead of
re-expressed in each.

Status: proposed

## Context

The eligibility predicate is currently duplicated across three runtimes that must
stay semantically equivalent:

- the real Claim, as Python SQL — `runner/synergy_runner/db.py:43-45`
  (`FOR UPDATE SKIP LOCKED`, `LIMIT 1`);
- the same membership predicate minus the `UPDATE`, built with `fmt.Sprintf` to
  feed the KEDA scaler — `internal/controller/runnerpool_controller.go:165-168`;
- a third copy with the cap `50` and version `24.1.0` **hardcoded** —
  `config/keda/scaledobject.yaml:28-31`.

A fourth copy is the SQL block in CONTRACT §2.2. The three runtime copies are
*semantically equal but textually divergent* (only the claim has `ORDER BY`;
placeholders vs. literals differ). The cap `50` is independently restated in ~7
sites (`api/v1/runnerpool_types.go:44`, `internal/api/config.go:44`,
`internal/controller/runnerpool_controller.go:108,161`,
`runner/synergy_runner/config.py:65`, `deploy/docker-compose.yml:108`, plus the
KEDA literal).

ADR-0005 already records, as an accepted consequence, that "the KEDA trigger
query and the claim query MUST share one eligibility definition, or the scaler and
the claimer disagree." Today they share only prose. Drift realises exactly the
failure mode ADR-0005 rejected: KEDA scales a RunnerPool on a count of "eligible"
work that no Runner can actually Claim.

The **Run Queue**, the **Claim**, and the **per-User cap** are named in
`CONTEXT.md` — but no module owns the predicate that defines them. Applying the
deletion test: there is nothing to delete, because the concept has no home; the
test instead tells us to *create* one. Concentrating the predicate removes a whole
class of cross-runtime drift.

## Decision

Make the eligibility predicate a deep module with one home — a Postgres function
`app.eligible_simulations(version, cap)` (or equivalent) in a migration:

- the **Claim** wraps it in `FOR UPDATE SKIP LOCKED` / `LIMIT 1`;
- the **KEDA** query selects `count(*)` over it;
- the per-User **cap** flows from the RunnerPool spec (see ADR-0015) rather than a
  YAML literal.

The interface is `(version, cap) → eligible rows`; what sits behind the seam (the
exact membership SQL) becomes private and changeable in one place.

## Considered options

- **A shared SQL function (preferred)** — one home in Postgres, where the data
  already lives; both runtimes call it. Matches ADR-0002 (Postgres is the source
  of truth).
- **A generated query string emitted from one Go definition** — keeps the logic
  in Go but must still be injected into Python; weaker locality, two consumers of
  a generated string.
- **Status quo + a conformance test** — a test that asserts the three copies stay
  equivalent. Cheaper, but defends a duplication rather than removing it.

## Consequences

- **Locality:** "what is claimable" lives in one place; changing fairness (e.g.
  priority-aware caps) is one edit, not a three-runtime hunt.
- **Leverage:** the Claim, the scaler, and any future admission check ride the
  same definition.
- **Tests:** the predicate becomes the test surface — one DB-level test proves
  eligibility, replacing trust that three SQL strings agree by eye.
- A migration that introduces SQL functions is new territory for this codebase;
  the only prior in-schema logic is the `app.sync_batch_counts` trigger
  (migration `0004`). The team should agree on a convention for versioning and
  testing PL/pgSQL before leaning on it further (see ADR-0013).
