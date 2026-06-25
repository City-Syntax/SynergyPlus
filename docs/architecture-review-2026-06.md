# Architecture review — June 2026

A review of architectural friction in SynergyPlus, framed as **deepening
opportunities**: turning shallow modules deep, improving locality and
testability. Vocabulary follows the project's `CONTEXT.md` (Run Queue, Claim,
Lease, Content Hash, Runner, RunnerPool, per-User cap) and the `/codebase-design`
design language (module, interface, depth, seam, adapter, leverage, locality, the
deletion test).

Each candidate below is recorded as a **proposed** ADR (`docs/adr/0011`–`0015`).
They are recommendations for the team to ratify or reject, not yet-accepted
decisions.

## The recurring shape

SynergyPlus has an excellent domain glossary, but several concepts it names own
**no module**. Their definitions live as raw SQL strings and hash recipes copied
across three runtimes (Go, Python, KEDA YAML), bound together only by prose in
`docs/CONTRACT.md`. The deepening move is the same each time: give the concept one
home, and let the other runtimes consume it through a narrow seam.

## Candidates

| # | Candidate | Verified evidence (first-hand) | Strength |
|---|-----------|-------------------------------|----------|
| [0011](adr/0011-single-home-claim-eligibility.md) | The Claim eligibility predicate is smeared across three runtimes | `runner/synergy_runner/db.py:44-45`, `internal/controller/runnerpool_controller.go:165-168`, `config/keda/scaledobject.yaml:28-31` — the per-User cap **predicate**, semantically equal, textually divergent. (The cap *number* is largely single-sourced; the predicate is the real duplication.) | **Strong** |
| [0012](adr/0012-canonical-content-hash.md) | A result's identity (Content Hash) is computed twice, in two languages | `internal/queue/queue.go:27` (Go) and `runner/synergy_runner/loop.py:26` (Python); spec in CONTRACT §2.1. No shared test vector. | **Strong** |
| [0013](adr/0013-lifecycle-transitions-owned-by-sql.md) | The Simulation lifecycle state machine has no single owner | Forward transitions are Python SQL (`db.py` claim/heartbeat/finish); recovery is Go SQL (`internal/queue/reaper.go`). The `runner_id` fence is in two Python sites (`db.py:57,221`); the Reaper is expiry-only (`reaper.go:69,76`). | Worth exploring |
| [0014](adr/0014-single-source-identity-across-seam.md) | Identity is re-implemented across the portal/apiserver seam | Key hash in `portal/src/lib/api-keys.ts:25` **and** `internal/api/auth.go:22`; domain list defined 3× (`env.ts:6`, `LoginForm.tsx:6`, `auth.ts:26-30` helper). | Worth exploring |
| [0015](adr/0015-runnerpool-cr-single-source.md) | Engine Version is re-typed across deploy manifests | `24.1.0` in ~8 live-manifest sites. **Correction:** the live KEDA query *does* derive from the CR (`controller.go:161,165-169`); the residuals are the in-CR image tag and the operator-less Compose path. | Speculative |

## Top recommendation — start with ADR-0011

Tackle the **Claim eligibility predicate** first:

- **Highest blast radius today.** ADR-0005 already states as an accepted
  consequence that "the KEDA trigger query and the claim query MUST share one
  eligibility definition, or the scaler and the claimer disagree." Today they
  share only prose — a drift is a production autoscaling bug (Runners scaled for
  work they can't Claim).
- **It's the keystone.** Giving the predicate one home is the natural anchor for
  the Lease transitions (ADR-0013), which compose over the same Claim. (Note: the
  cap literal is *not* a shared dependency — it is already single-sourced in the
  live operator path; see ADR-0011's caveat and ADR-0015.)
- **Cleanest deletion-test win.** The Run Queue / Claim / per-User cap are named
  in `CONTEXT.md` but owned by no module — a real domain noun with no code home.
- **A non-obvious design constraint, found by empirical test.** The naive
  implementation — wrapping `app.eligible_simulations(…) FOR UPDATE SKIP LOCKED` —
  *silently drops the row lock* on Postgres 16 (no `LockRows` node; verified with
  `EXPLAIN` + a two-session concurrency test). The function must be a **membership
  gate** with `FOR UPDATE OF <base table> SKIP LOCKED` kept on the caller. ADR-0011
  records this.

ADR-0012 (Content Hash) is the natural second: same "smeared domain concept"
shape, smaller surface, and a shared test-vector seam is a one-afternoon win that
closes a silent-correctness gap.

## Method

Findings were produced in two multi-agent validation passes (five investigators,
each in an adversarial QA loop), and **re-verified first-hand** against the code.
Every `file:line` in the ADRs was confirmed by direct reading.

The **first pass self-contaminated**: one investigation agent, given write access
to the shared working tree, materialized a proposed migration
(`db/migrations/0006_lifecycle_functions.sql`); later QA agents "discovered" it and
the loop converged on treating an agent-authored file as pre-existing repository
code. That artifact was removed and no conclusion here rests on it.

The **second pass ran each agent in its own isolated git worktree** off `master`,
strictly read-only, with a mandatory contamination check (every "already exists
in-tree" claim must be proven with `git ls-files`). It held: all five worktrees
ended with **zero writes**, the contamination check passed for every candidate,
and the independent re-validation *corrected* several first-pass claims — the cap
duplication in ADR-0011 (over-stated), the locking design in ADR-0011 (the
silent-lock-drop above), the fence count in ADR-0013 (two Python sites, not
three), the allow-list shape in ADR-0014 (a list defined 3×, not logic duplicated),
and ADR-0015's central premise (the live KEDA query already derives from the CR).
The ADRs here reflect the corrected, isolation-validated findings. The lesson:
validation agents must be read-only and isolated, or their own scratch becomes
evidence.
