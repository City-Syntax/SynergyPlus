# SynergyPlus — Independent Security Audit

**Date:** 2026-06-25
**Scope:** Go apiserver + operator (`cmd/`, `internal/`, `api/`), Python runner
(`runner/`), Next.js portal (`portal/`), DB schema (`db/migrations/`), and
deployment (`deploy/`, `config/`, Dockerfiles). Review only — no changes made.
**Method:** manual source review of the auth, authorization, file-transfer,
queue, and deployment paths; git-history secret scan.

## Executive summary

The core mechanics are solid: SQL is fully parameterized (no injection found),
API keys are 192-bit random and stored as SHA-256, the portal enforces the
email-domain allow-list in two places, queue state transitions are guarded by
SQL functions, and most containers run as non-root.

The headline problem is **authorization, not authentication**. Authentication
(who are you) is enforced everywhere under `/v1`; **object-level authorization
(may you see *this* object) is missing on every read endpoint except one.** Any
valid API key can read any other user's simulations, results, and batches. A
secondary cluster of issues is around *defaults that fail open* — a dev login
backdoor that is on unless explicitly disabled, an over-privileged shared
ServiceAccount, and a live SMTP credential in the working tree.

| # | Severity | Finding |
|---|----------|---------|
| 1 | **High** | Broken object-level authorization (IDOR) on all read endpoints |
| 2 | **High** | Dev magic-link backdoor enabled by default (`/api/dev/last-link`) |
| 3 | **High** | Internet-facing apiserver shares the operator's cluster-wide ServiceAccount |
| 4 | Medium | Live Gmail SMTP app-password in `portal/.env`; `gmail.com` in allow-list |
| 5 | Medium | Unvalidated `model_ref`/`weather_ref` → arbitrary file/object read on runner |
| 6 | Medium | Placeholder `BETTER_AUTH_SECRET` shipped in compose + code default |
| 7 | Medium | Runner container processes untrusted EnergyPlus input as root |
| 8 | Low | No batch-size cap; `maxParallelism` accepted but ignored (resource DoS) |
| 9 | Low | No rate limiting on the API |
| 10 | Info | Content-hash cache is a cross-user existence/metrics oracle |
| 11 | Info | `sslmode=disable` / plain-HTTP presign assumed for the cloud path |

---

## Remediation status (2026-06-28, v0.6.5)

Addressed before the v0.6.5 release. Verified with `go build` / `go vet` /
`go test ./internal/...`, portal `tsc`, and manifest YAML validation.

| # | Status | What changed |
|---|--------|--------------|
| 1 | **Fixed** | Object-level ownership checks on all four read handlers (`handleGetSimulation`/`handleGetResult`/`handleGetBatch`/`handleListBatchSimulations`): a non-owner now gets the same 404 as a missing object (no existence leak), mirroring `handleListArtifacts`. New `internal/api/handlers_authz_test.go`. |
| 2 | **Fixed** | `devLoginEnabled` is fail-closed — OFF unless `PORTAL_DEV_LOGIN=1` is set explicitly (no NODE_ENV default). Local compose opts in but binds the portal to `127.0.0.1`. |
| 3 | **Fixed** | Prod already runs the apiserver under its scoped IRSA SA (overlay). The base manifest no longer shares the operator's cluster-wide SA — it uses the no-RBAC `default` SA locally. (Base kept free of automount/SA changes that would propagate to and break the prod IRSA path.) |
| 4 | **Partial — rotation required** | Live API token removed from `sample/notebook.ipynb`. **ACTION REQUIRED (operator only):** revoke the two exposed `sp_live_…` tokens (the working-tree one and the one already in git history) and the Gmail app-password; drop `gmail.com` from any prod allow-list. |
| 5 | **Fixed** | Server-side `validateInputRef` at submit time: model/weather must be `s3://` into the kind's bucket — blocks `file://`, bare paths, and cross-bucket reads. |
| 6 | **Fixed** | Portal refuses to start in production with an unset/placeholder `BETTER_AUTH_SECRET` (`portal/src/instrumentation.ts`, runtime-only so the build's placeholder is unaffected). Compose given a real local secret. |
| 7 | **Fixed (image); k8s SC follow-up** | Runner image runs as non-root UID 10001. Follow-up: hardened `securityContext` on operator-created runner pods. |
| 8 | **Partial** | Batch variant count capped (`SP_MAX_BATCH_VARIANTS`, default 10000). `maxParallelism` still accepted-and-ignored (left as-is to avoid breaking existing clients; honor or reject in a later release). |
| 9 | **Deferred** | Rate limiting belongs at the gateway/ingress, not the app image. |
| 10 | **Accepted** | Inherent to the input-keyed global cache (ADR-0007); the #1 fix removes the cross-user read-back path. |
| 11 | **Deferred to deploy** | TLS to Postgres/S3 is enforced by the prod IaC (SynergyPlusIAC), not these local manifests. |

---

## 1. Broken object-level authorization (IDOR) — High

**Where:** `internal/api/handlers.go` — `handleGetSimulation` (L99),
`handleGetResult` (L250), `handleGetBatch` (L202), `handleListBatchSimulations`
(L220); store methods `GetSimulation`/`GetResult`/`GetBatch`/`ListBatchSimulations`
in `internal/store/store.go` look up purely by `id`, never by `user_id`.

The auth middleware resolves the caller's `user_id` and stashes it in context,
but these four handlers never compare it against the fetched row's owner. Only
`handleListArtifacts` (`internal/api/uploads.go:172`) does
`if sim.UserID != userID(r.Context())`. There is no row-level security in the
DB either (`grep` for POLICY/RLS in `db/migrations/` → none).

**Impact:** any authenticated user (any of the ~40 lab API keys, or any future
self-service key) can read **any** simulation's state, verdict, metrics, error
messages, and model/weather refs; any batch's composition and counts; and any
result's metrics — by ID. The contract explicitly designed the artifacts
endpoint to return 404 with "no existence leak," but the sibling endpoints leak
the same objects' metadata and metrics freely. IDs are UUIDs (not trivially
enumerable), so this is a confidentiality break rather than a full dump — but
IDs routinely leak via logs, SDK output, support tickets, and the batch-listing
endpoint itself.

**Fix:** add an ownership check to each read handler (return the same 404 the
artifacts endpoint uses, to avoid an existence oracle). Best done at the store
layer — pass `userID` into `GetSimulation`/`GetResult`/`GetBatch`/
`ListBatchSimulations` and add `AND user_id = $n` (for results, join through the
simulation). Consider Postgres RLS as a defense-in-depth backstop.

## 2. Dev magic-link backdoor on by default — High

**Where:** `portal/src/lib/env.ts:40` (`devLoginEnabled` defaults **on** when
`NODE_ENV !== "production"`), `portal/src/app/api/dev/last-link/route.ts`,
`deploy/docker-compose.yml` (`PORTAL_DEV_LOGIN: "1"` hardcoded for the portal).

When dev login is enabled, `GET /api/dev/last-link?email=<anyone>@<allowed-domain>`
returns a **working magic-link URL/token** for that email, and the
`sendMagicLink` callback logs the link instead of mailing it. Anyone who can
reach the portal can request a link for an arbitrary allowed-domain user and log
in as them — full account takeover, then API-key minting as that user.

This is correct for laptop-local dev, but it is **fail-open**: it is enabled
unless someone remembers to set `NODE_ENV=production` *and/or* `PORTAL_DEV_LOGIN=0`.
The shipped compose file — the documented "run it locally" path in the README —
turns it on explicitly. If that compose stack (or any deploy that didn't set the
flag) is ever exposed beyond localhost, it's an unauthenticated account-takeover.

**Fix:** gate the dev backdoor on an explicit positive opt-in that can never be
true in a built image (e.g. require `PORTAL_DEV_LOGIN=1` *and* refuse to start if
it's set while `NODE_ENV=production`). Remove `PORTAL_DEV_LOGIN: "1"` from any
compose file intended to be copied, or bind the portal to `127.0.0.1` there.

## 3. apiserver shares the operator's cluster-wide ServiceAccount — High

**Where:** `config/manager/manager.yaml` — the `synergyplus-apiserver`
Deployment sets `serviceAccountName: synergyplus-operator`; that SA is bound
(via ClusterRoleBinding in `config/rbac/role.yaml`) to a ClusterRole that can
`create/update/delete` **Deployments cluster-wide**, plus RunnerPools and KEDA
ScaledObjects.

The apiserver is the internet-facing component and needs **zero** Kubernetes
API access (it only talks to Postgres and S3). Binding it to the operator's SA
means a single apiserver RCE/SSRF (and note finding #5 gives an attacker a foot
in the runner/apiserver trust zone) escalates to "create a Deployment in any
namespace" → arbitrary pod execution → cluster takeover.

**Fix:** give the apiserver its own ServiceAccount with no RBAC (or
`automountServiceAccountToken: false`). Scope the operator's Deployment
permissions to its target namespace with a namespaced Role where possible.

## 4. Live SMTP credential in working tree; `gmail.com` in allow-list — Medium

**Where:** `portal/.env`.

```
SMTP_USER=ryan@urbanflow.co
SMTP_PASS=osudjauiatbttyqz          # real 16-char Gmail app password
ALLOWED_EMAIL_DOMAINS=urbanflow.co,nus.edu.sg,gmail.com
```

Good news: this file is **not** in git history (`git log -S` and
`git log -- portal/.env` both empty) and is covered by `portal/.gitignore`, so
it has not been committed. But it is a **live Gmail app password sitting in
plaintext** in the shared working tree and should be treated as exposed.

Separately, the live `.env` adds **`gmail.com`** to the login allow-list. For a
lab meant to be `@urbanflow.co` / `@nus.edu.sg`, this opens self-service signup
+ API-key creation to the entire public Gmail population (anyone can request a
magic link and, in production, receive it at their own Gmail).

**Fix:** rotate the Gmail app password now (revoke it in the Google account).
Move SMTP creds to a secret manager. Remove `gmail.com` from the allow-list
unless personal Gmail access is genuinely intended.

## 5. Unvalidated artifact refs → arbitrary read on the runner — Medium

**Where:** `runner/synergy_runner/storage.py:40` (`download` accepts `s3://`,
`file://`, and **bare local paths**), reached from `loop.py:_fetch_input` with
`sim["model_ref"]`/`sim["weather_ref"]`; the apiserver
(`handlers.go:51`/`134`) validates only that the refs are non-empty — never that
they are `s3://` into the `models`/`weather` buckets.

A user can submit a simulation with `model_ref: "file:///etc/passwd"`,
`"/var/run/secrets/..."`, or `s3://results/<another-users-hash>/eplusout.sql`.
The runner fetches it (as root, with S3 credentials that can read every bucket),
copies it into the workspace, and SHA-256s it. Direct exfiltration is limited —
EnergyPlus won't echo the bytes into its outputs, and results are owner-scoped —
but it is a genuine arbitrary-file / cross-tenant object read primitive and a
SHA-256 oracle, and it violates least privilege. It also pairs badly with #3
(shared trust zone) and #7 (root).

**Fix:** validate refs server-side at submit time — require `s3://` and restrict
the bucket to the kind's expected bucket (and ideally the `uploads/` prefix the
presign flow mints). In the runner, drop the `file://`/bare-path branch outside
tests, and scope the runner's S3 credentials to the buckets it needs.

## 6. Placeholder auth secret shipped — Medium

**Where:** `deploy/docker-compose.yml`
(`BETTER_AUTH_SECRET: dev-secret-change-me-to-a-long-random-string`),
`portal/src/lib/env.ts:31` (code default
`dev-only-insecure-secret-change-me-...`), `portal/.env`
(`change-me-to-a-long-random-string-min-32-chars`).

If any of these reach a reachable deploy, session tokens are signed with a known
secret → trivial session forgery / impersonation. The portal Dockerfile also
bakes a `build-time-placeholder-secret` (only used at build, acceptable, but
must be overridden at runtime — there is no startup guard that it was).

**Fix:** fail startup if `BETTER_AUTH_SECRET` is unset or equal to any known
placeholder. Generate per-install secrets from a secret manager.

## 7. Runner runs untrusted input as root — Medium

**Where:** `runner/Dockerfile` — no `USER`; runs as root, unlike the apiserver
(distroless nonroot) and portal (`nextjs` user).

The runner executes the real EnergyPlus binary (a large C++ codebase) on
user-supplied `.idf`/`.epw` files as root. A parser memory-safety bug becomes
root-in-container, and with #5 the same process already reads arbitrary paths.

**Fix:** add a non-root `USER`, a read-only root FS where feasible, drop
capabilities, and run under a restrictive seccomp profile. On k8s set a
hardened `securityContext` for runner pods.

## 8. No batch-size cap; `maxParallelism` ignored — Low

**Where:** `internal/api/handlers.go:128` — `handleCreateBatch` bounds variants
only by `> 0` (no upper limit); `maxParallelism` is parsed into the DTO
(`handlers.go:38`) but **never used** (`grep` shows no reads in `internal/`,
and `queue.ExpandSpec` has no such field).

A single request with millions of variants is accepted; expansion runs in a
detached goroutine with a 30-min timeout, inserting unbounded rows and queuing
unbounded real EnergyPlus runs (each gated only by the global per-user cap of
50, so it ties up capacity indefinitely). The `maxParallelism` knob users think
they're setting is silently dropped.

**Fix:** enforce a maximum variant count per batch (and per-user queued total);
either honor `maxParallelism` or reject it so callers aren't misled.

## 9. No rate limiting — Low

No throttling on `/v1/*` (`grep` for rate/throttle/limiter → none). Submission,
upload-URL minting, and the unauthenticated `/healthz` are all unbounded. For
~40 trusted users this is low risk, but combine with #8 for cheap resource
exhaustion. Add per-key rate limits at the gateway/ingress.

## 10. Content-hash cache is a cross-user oracle — Info

`POST /v1/simulations` (handlers.go:66) marks a sim `succeeded` immediately when
the supplied `model_sha256`+`weather_sha256` already have a cached result. A
user who knows (or guesses) another user's exact input digests can detect that
the input was previously run and then read its metrics via #1. This is an
inherent property of an input-keyed global cache (ADR-0007); flagging so it's a
conscious tradeoff. If model confidentiality matters, scope cache hits to the
owning user or require possession of the actual bytes.

## 11. Transport posture for the cloud path — Info

`DATABASE_URL` uses `sslmode=disable` everywhere (incl.
`deploy/k8s-local/secret.yaml`), and presigned URLs are served over plain HTTP
locally. Fine for an in-cluster/local demo; for the documented AWS path, require
TLS to Postgres (`sslmode=require`/`verify-full`) and HTTPS S3 endpoints, and
confirm the apiserver sits behind TLS termination.

---

## What's done well

- **No SQL injection:** every query in `store.go`, `queue/`, and the runner's
  `db.py` uses bound parameters; state transitions are centralized in guarded
  SQL functions (ADR-0013).
- **Strong API keys:** `sp_live_<48 hex>` = 192 bits of CSPRNG entropy
  (`portal/src/lib/api-keys.ts`), stored only as SHA-256; raw key shown once.
- **Allow-list defense in depth:** portal enforces the email domain in both the
  `before` hook and `databaseHooks.user.create.before` (`portal/src/lib/auth.ts`).
- **Key management is correctly scoped:** list/revoke are filtered by
  `user_id` (`api-keys.ts`), unlike the simulation read paths.
- **Presigned uploads are bound** to one bucket+key with a sanitized basename
  (`uploads.go:80`), and URL lifetime is clamped to ≤15 min (`config.go:38`).
- **Container hardening (mostly):** apiserver is distroless/nonroot, portal runs
  as an unprivileged user.
- **No secrets in git history.**

## Suggested priority

1. Fix #1 (ownership checks on read endpoints) — the one issue exploitable by
   any current legitimate user.
2. Rotate the Gmail credential (#4) and neutralize the dev backdoor default (#2).
3. Split the apiserver off the operator SA (#3) before any non-local deploy.
4. Then #5–#7, then #8–#11.
