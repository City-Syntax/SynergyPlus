# One canonical Content Hash, pinned by a cross-runtime test vector

The **Content Hash** — the identity of a Simulation's result, and the basis of
dedup and idempotency — is defined once in `docs/CONTRACT.md` §2.1 but *derived*
independently in two languages. Formalise the two derivations as an adapter pair
bound by a shared, checked-in test vector (or collapse them to one home).

Status: proposed

## Context

`Content Hash = sha256(model_sha256 ":" weather_sha256 ":" engine_version)` is
implemented twice:

- Go — `internal/queue/queue.go:27` (`ContentHash`), computed at submit time for
  cache resolution;
- Python — `runner/synergy_runner/loop.py:26` (`content_hash`), recomputed after
  the Runner fetches the real input digests and back-fills the row.

The two strings must agree byte-for-byte. A one-byte divergence — a separator, an
ordering, a trim — makes the Runner write a result under a key the API will never
look up: cache hits silently become misses and idempotency (ADR-0003) breaks
silently. There is **no test that pins the two implementations to the same
vector**; the only thing binding them is CONTRACT prose.

This is the worst kind of shallow duplication: each copy *looks* redundant, but
each is load-bearing for a different actor (the API issuer, the Runner
back-filler). The design rule applies directly — *one adapter is a hypothetical
seam; two are a real one* — and here there are two.

## Decision

Treat the Go and Python hashers as a deliberate two-adapter seam and pin it:

- add a checked-in **test-vector table** — `(model_sha, weather_sha, version) →
  expected hash` — that both the Go test suite and the Python test suite assert
  against. The duplication becomes a verified seam: either adapter drifting fails
  a build.

Alternatively (larger move), compute the hash in **one** place — a Postgres
`app.content_hash(...)` function both runtimes read — eliminating the second
adapter entirely. Preferred only if ADR-0011's "logic in Postgres" direction is
adopted broadly.

## Considered options

- **Shared test vector (preferred, low-cost)** — keeps both adapters, removes the
  silent-drift risk, ships in an afternoon.
- **Single Postgres function** — strongest locality, but couples hash computation
  to a DB round-trip at submit time and only pays off alongside ADR-0011.
- **Do nothing** — relies on reviewers noticing a one-character change in either
  hasher; the failure is silent and corrupts the Result Cache.

## Consequences

- **Tests:** "trust the prose" becomes a failing build the moment either side
  drifts; the vector file is the single source of truth for the format.
- **Leverage:** future consumers keyed by Content Hash (a re-run tool, an
  artifact GC per ADR-0008) inherit the guarantee.
- A vector file must be updated deliberately if the hash format ever changes —
  which is the point: the format change becomes visible and reviewed.
