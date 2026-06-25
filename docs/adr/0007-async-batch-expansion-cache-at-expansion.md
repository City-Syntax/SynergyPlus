# Asynchronous batch expansion, with the cache resolved at expansion time

A submitted Batch is accepted immediately — the API writes one `batch` row in an
`Expanding` state and returns a `batch_id` — and a background **expander** bulk-inserts
the individual Simulation rows in chunks. During expansion it resolves the
content-hash cache: any variant whose Content Hash already has a result is marked
`Succeeded` and **never enters the queue**. Small submissions (≤ ~100 runs) take a
synchronous fast path so single interactive runs feel instant. Submission is
idempotent on a client-supplied key.

Status: accepted

## Considered options

- **Synchronous expansion** — simpler, but the request blocks for a 100k-row insert and
  is messy on a mid-insert disconnect. Acceptable only while batches stay small.
- **Cache check at claim time** — rejected: cached work would still occupy the queue and
  burn a Runner's claim to discover there's nothing to do.

## Consequences

- A Batch has a transient `Expanding` state, so "submitted" ≠ "fully queued" for a few
  seconds; the SDK/UI must surface it.
- Resolving the cache at expansion can collapse a re-submitted or overlapping sweep from
  100k runs to a few hundred real ones.
- The SDK is expected to compute input `sha256` (the `ArtifactRef.sha256` field) so cache
  resolution needs no blob reads; absent that, the hash is deferred to fetch time.
