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
| [0011](adr/0011-single-home-claim-eligibility.md) | The Claim eligibility predicate is smeared across three runtimes | `runner/synergy_runner/db.py:43-45`, `internal/controller/runnerpool_controller.go:167`, `config/keda/scaledobject.yaml:31` — the per-User cap predicate, semantically equal, textually divergent. Cap `50` restated in ~7 places. | **Strong** |
| [0012](adr/0012-canonical-content-hash.md) | A result's identity (Content Hash) is computed twice, in two languages | `internal/queue/queue.go:27` (Go) and `runner/synergy_runner/loop.py:26` (Python); spec in CONTRACT §2.1. No shared test vector. | **Strong** |
| [0013](adr/0013-lifecycle-transitions-owned-by-sql.md) | The Simulation lifecycle state machine has no single owner | Forward transitions are Python SQL (`db.py` claim/heartbeat/finish); recovery is Go SQL (`internal/queue/reaper.go`). The `runner_id` fence is re-written in each. | Worth exploring |
| [0014](adr/0014-single-source-identity-across-seam.md) | Identity is re-implemented across the portal/apiserver seam | Key hash in `portal/src/lib/api-keys.ts:25` **and** `internal/api/auth.go:22`; allow-list in `env.ts:6`, `LoginForm.tsx:6`, `auth.ts:71,85`. | Worth exploring |
| [0015](adr/0015-runnerpool-cr-single-source.md) | Engine Version & cap are literals scattered across ~8 manifests | `24.1.0` in 8 config sites; cap `50` in ~7. RunnerPool CR is the intended single source (ADR-0006) but image tag & KEDA query don't derive from it. | Speculative |

## Top recommendation — start with ADR-0011

Tackle the **Claim eligibility predicate** first:

- **Highest blast radius today.** ADR-0005 already states as an accepted
  consequence that "the KEDA trigger query and the claim query MUST share one
  eligibility definition, or the scaler and the claimer disagree." Today they
  share only prose — a drift is a production autoscaling bug (Runners scaled for
  work they can't Claim).
- **It's the keystone.** Giving the predicate one home dissolves the cap-`50`
  literal (ADR-0015) and is the natural anchor for the Lease transitions
  (ADR-0013). One deepening unlocks three.
- **Cleanest deletion-test win.** The Run Queue / Claim / per-User cap are named
  in `CONTEXT.md` but owned by no module — a real domain noun with no code home.

ADR-0012 (Content Hash) is the natural second: same "smeared domain concept"
shape, smaller surface, and a shared test-vector seam is a one-afternoon win that
closes a silent-correctness gap.

## Method & a methodology caveat

Findings were produced by a multi-agent validation pass (five investigators, each
in an adversarial QA loop) and then **re-verified first-hand** against the code
before being recorded here. Every `file:line` in the ADRs was confirmed by direct
reading.

One caveat, recorded for honesty: the automated loop **self-contaminated**. One
investigation agent, given write access, materialized a proposed migration
(`db/migrations/0006_lifecycle_functions.sql`) into the working tree; later QA
agents then "discovered" it and the loop converged on treating an agent-authored
file as pre-existing repository code. That artifact was removed and **none of the
conclusions in these ADRs rely on it** — they rest only on the duplication that
exists in the committed source. The lesson: validation agents must be read-only,
or their own scratch becomes evidence.
