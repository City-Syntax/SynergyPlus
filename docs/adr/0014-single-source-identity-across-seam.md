# One source of truth for identity across the portal/apiserver seam

The two facts that define a **User**'s identity across the portal↔apiserver seam —
how an API key hashes, and which email domains are allowed — should each have a
single source, instead of being re-implemented on both sides and tripled within
the portal.

Status: proposed

## Context

This does not reopen ADR-0009 (self-hosted Better Auth + a portal-issued API-key
model); it tightens the seam that ADR created.

Two identity facts are duplicated across the boundary:

- **API-key hash.** `sha256(key)` is implemented in TypeScript —
  `portal/src/lib/api-keys.ts:25` (`hashKey`) — *and* in Go —
  `internal/api/auth.go:22` (`HashAPIKey`). The portal issues the key; the
  apiserver validates it. There is no round-trip test, so a typo in either
  hasher silently 401s every key with no visible cause.
- **Domain allow-list.** `["urbanflow.co", "nus.edu.sg"]` is written three+ times
  inside the portal alone — `portal/src/lib/env.ts:6`,
  `portal/src/app/login/LoginForm.tsx:6`, and enforced twice in
  `portal/src/lib/auth.ts:71,85` — and the Go apiserver has *no* allow-list at
  all, fully trusting the portal as sole gatekeeper. Adding a lab domain is a
  four-site edit.

## Decision

- Treat key-hashing as a two-adapter seam pinned by a shared vector (same
  mechanism as ADR-0012) and add one **create-key → validate-key** contract test
  that exercises the portal issuer against the Go validator end-to-end.
- Collapse the portal's tripled allow-list to a single exported constant
  (`ALLOWED_DOMAINS` in `env.ts`) consumed by the form, the magic-link hook, and
  the message strings.
- Decide deliberately whether domain enforcement belongs at the **data boundary**
  (a `CHECK` / insert trigger on `app.users`) so the invariant survives a portal
  bug, rather than living only in TypeScript.

## Considered options

- **Shared vector + single allow-list constant + DB-level enforcement
  (preferred)** — narrows the seam and adds defense in depth without reopening
  ADR-0009.
- **Allow-list as injected config** instead of a source constant — lets policy
  change without a redeploy; orthogonal and can be layered on.
- **Status quo** — relies on reviewers catching a one-character hash change and on
  the portal never being the weak link.

## Consequences

- **One source of truth** for "who is allowed"; adding a domain is one edit.
- **Tests:** the create→validate contract test covers the auth seam that is
  currently entirely untested.
- **Defense in depth:** the allow-list invariant stops depending on the portal
  being the only door.
- Moving enforcement to the DB boundary touches the auth schema (migration
  `0002_auth.sql`); scope it as its own change.
