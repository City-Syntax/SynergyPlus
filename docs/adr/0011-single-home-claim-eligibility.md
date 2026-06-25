# Give the Claim eligibility predicate a single home

The rule that decides which queued Simulation a Runner may **Claim** — the
per-User fairness predicate `count(running for user) < cap`, gated by Engine
Version, plus the priority/age ordering — should live in **one place** (a Postgres
function, e.g. `app.eligible_simulations(version, cap)`), consumed by every
runtime instead of re-expressed in each.

Status: proposed

## Context

The eligibility predicate is currently duplicated across three runtimes that must
stay semantically equivalent:

- the real Claim, as Python SQL — `runner/synergy_runner/db.py:37-51` (`CLAIM_SQL`,
  predicate at `:44-45`), with `FOR UPDATE SKIP LOCKED` / `LIMIT 1`;
- the same membership predicate minus the `UPDATE`, built with `fmt.Sprintf` to
  feed the KEDA scaler — `internal/controller/runnerpool_controller.go:165-168`
  (`eligibleQuery`, wired into the trigger at `:188`);
- a third copy with the cap and version hardcoded in the *documentation sample*
  manifest — `config/keda/scaledobject.yaml:28-31`.

A fourth authored copy is the SQL block in CONTRACT §2.2 (`docs/CONTRACT.md:66-84`).
The three runtime copies are *semantically equal but textually divergent*, and
already only **approximately** equivalent: the Python Claim serialises its
count-then-claim under `pg_advisory_xact_lock(42)` (the H-2 hard-ceiling guard,
`db.py:60-66,108-119`) which the Go/YAML count does not model.

ADR-0005 records, as an accepted consequence, that "the KEDA trigger query and the
claim query MUST share one eligibility definition, or the scaler and the claimer
disagree." Today they share only prose; a drift realises exactly the failure mode
ADR-0005 rejects (KEDA scales a RunnerPool on a count of "eligible" work no Runner
can actually Claim).

The **Run Queue**, the **Claim**, and the **per-User cap** are named in
`CONTEXT.md`, but no module owns the predicate that defines them. The deletion
test confirms the shape: there is nothing to delete, because the concept has no
home — so the test tells us to *create* one. Concentrating the predicate removes a
class of cross-runtime drift.

> **Caveat on the cap literal.** The cap `50` appears in ~7 sites, but these are
> not co-equal copies. In the only path with both a claimer and a scaler (the
> operator), the cap already flows from one field —
> `pool.Spec.DefaultUserConcurrency` — into both the Runner env
> (`runnerpool_controller.go:108`) and the KEDA query (`:161`); each literal `50`
> is merely the fallback for the optional spec field. The apiserver's `PerUserCap`
> (`internal/api/config.go:44`) is explicitly "informational … enforced in claim
> query", and the Compose path has no scaler. So the *cap parameter* is largely
> single-sourced where it matters; the genuine duplication is the **predicate**,
> not the number.

## Decision

Make the eligibility predicate a deep module with one home — a Postgres function
`app.eligible_simulations(p_engine_version text, p_user_cap int) RETURNS SETOF
app.simulations` (`LANGUAGE sql STABLE`), in a new tracked migration. It owns the
**predicate** (`state='queued' AND engine_version=p AND per-user running-count <
cap`) and the **ordering** (`priority DESC, created_at ASC`). It owns neither row
locking nor the `UPDATE`.

Two SQL surfaces compose over that one body:

- **KEDA eligible-depth:** `SELECT count(*) FROM app.eligible_simulations($1,$2)`
  — the function used directly.
- **Claim:** the function is a **membership gate**, *not* the lockable relation.
  The `UPDATE` still locks the base table:
  `… WHERE s.id = (SELECT s2.id FROM app.simulations s2 JOIN
  app.eligible_simulations($v,$cap) e ON e.id=s2.id ORDER BY s2.priority DESC,
  s2.created_at ASC FOR UPDATE OF s2 SKIP LOCKED LIMIT 1)`.

> **Why locking cannot move behind the function (verified empirically on
> Postgres 16.14).** The intuitive form — `SELECT id FROM
> app.eligible_simulations(…) FOR UPDATE SKIP LOCKED LIMIT 1` — is **not**
> rejected by the planner; it *silently drops the row lock* (no `LockRows` node in
> `EXPLAIN`). A two-session concurrency test reproduced the harm: the second
> session selected the same row, blocked ~2s on the first session's write lock,
> then overwrote it, and a second claimable row went unclaimed. Keeping
> `FOR UPDATE OF s2 SKIP LOCKED` on the base table restores the `LockRows` node
> and correct skip-locked behaviour. Locking and `LIMIT 1` are intrinsic to the
> Claim *act*, not the eligibility *definition*, so they stay in the caller.

The cap flows from the RunnerPool spec (see ADR-0015) rather than a literal.

## Considered options

- **A shared SQL function used as a membership gate (preferred)** — one home for
  the predicate; the Claim composes locking over the base table; KEDA counts the
  function. Matches ADR-0002 (Postgres is the source of truth).
- **Push locking + LIMIT into the function too** — rejected: silently drops the
  row lock on Postgres 16 (verified), a correctness regression worse than the
  duplication.
- **Status quo + a conformance test** asserting the three copies stay equivalent —
  cheaper, but defends a duplication rather than removing it, and cannot model the
  H-2 advisory-lock asymmetry.

## Consequences

- **Locality:** the eligibility predicate and ordering live in one place; changing
  fairness (e.g. priority-aware caps) is one edit, not a three-runtime hunt.
- **Leverage:** the Claim, the scaler, and any future admission check ride the
  same definition.
- **Tests:** the predicate becomes the test surface — one DB-level test proves
  eligibility and eligible-depth, replacing trust that copies agree by eye.
- A migration introducing SQL functions is near-new territory; the only prior
  in-schema logic is the `app.sync_batch_counts` trigger (migration `0004`). Agree
  a convention for versioning/testing PL/pgSQL before leaning on it further (see
  ADR-0013), and note CONTRACT §1 currently freezes `db/migrations` under PM
  ownership.
