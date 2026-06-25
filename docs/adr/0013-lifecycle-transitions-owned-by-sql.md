# The Simulation lifecycle's running-phase transitions get a single owner

The legal transitions of a Simulation through its running phase
(`queued → running → succeeded/failed`, and `running → queued` on Lease expiry),
together with the `runner_id` fencing that protects them, should be owned by
guarded SQL functions rather than re-expressed as inline `UPDATE`s across two
runtimes.

Status: proposed

## Context

The running-phase state machine is split across languages:

- forward transitions are Python SQL in the Runner — `runner/synergy_runner/db.py`
  (`claim`, `heartbeat`, `finish_simulation`);
- the recovery transition is Go SQL in the operator — `internal/queue/reaper.go`
  (requeue when `attempts < max_attempts`, else fail).

No single artifact states the legal transitions. The `runner_id` fence — the
guard that stops a late-waking zombie Runner from clobbering a row that the Reaper
re-queued and another Runner has since Claimed (the "M-4" guard documented in
`db.py:210-213`) — is written in two Python sites: `heartbeat` (`db.py:57`) and
`finish_simulation` (`db.py:221`). The Reaper deliberately does **not** fence on
`runner_id`; it transitions purely on lease expiry (`reaper.go:69,76`). So the
split is asymmetric: the forward transitions and their fence live in the Runner
(Python), the recovery transitions live unfenced in the operator (Go), and "can
this write land?" still means reading both runtimes to reconstruct one state
machine.

This is a locality failure: a single concept (the Lease lifecycle) is smeared
across modules, the protecting invariant (the fence) is repeated in two Python
sites, and no one place declares which transitions are legal or which are fenced.

## Decision

Push each running-phase transition behind a guarded SQL function — `claim`,
`renew_lease`, `finish`, `reap` — that owns its own legal from-state and its
`runner_id` guard internally. The Python loop and the Go Reaper become thin
callers that *cannot express an illegal transition*: the interface makes the
invariant unstatable-wrongly. The state machine becomes readable off one
migration file.

This composes with ADR-0011 (the Claim is one such transition; its eligibility
predicate is the deep module that function wraps).

## Considered options

- **Guarded SQL functions (preferred)** — concentrates the lifecycle and its
  fences in the schema, next to the data and the `FOR UPDATE SKIP LOCKED` already
  there (ADR-0002). One DB-level test per transition, including the zombie/late-
  write races that are currently untested integration-only paths.
- **A shared lifecycle module per runtime** (Go package + Python module) — keeps
  logic in application code but must be implemented twice and kept in sync; weaker
  than a single home.
- **Status quo** — the fence stays repeated across the two Python sites and absent
  from the Reaper; correctness rests on every author knowing which transitions
  must carry the `runner_id` guard and which are expiry-only.

## Consequences

- **Locality:** the lifecycle and its fences live together, not scattered across
  `WHERE` clauses in two runtimes.
- **Depth:** callers lose the ability to forget the fence.
- **Tests:** each transition is independently testable against a real Postgres.
- Introduces PL/pgSQL the team must own and version (see the convention note in
  ADR-0011). This is the larger of the SQL-function moves; sequence it after
  ADR-0011 has established the pattern.
