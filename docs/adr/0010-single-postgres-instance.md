# A single Postgres instance backs the whole platform

One PostgreSQL instance holds the run queue, the result index, the result cache, and
the Better Auth schema (users + hashed API keys), each in its own schema. The API
gateway validates a presented API key by **local hashed-key lookup**, not by calling
the auth service per request. Chosen for operational simplicity and transactional
consistency across queue/index/cache.

Status: accepted

## Considered options

- **Separate datastores per concern** — stronger isolation and independent scaling, but
  more to operate and it loses the cross-concern transaction (claim + result write).
  Premature for a single ~40-user lab.
- **Auth via a per-request validation endpoint** — rejected: adds a hop and a hot-path
  runtime dependency on the auth service; a local lookup is simpler given the shared DB.

## Consequences

- One backup / HA / upgrade surface. A Postgres outage takes the whole platform down —
  acceptable for a single-lab deployment; revisit with read replicas or a split if scale
  demands.
- Schema-per-concern keeps a clean seam to split any one store out later without an
  application rewrite.
