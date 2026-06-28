# SynergyPlus — Developer Portal

A Next.js (App Router) + TypeScript developer portal for SynergyPlus researchers.
It handles **domain-restricted login** (Better Auth) and **API-key management**, and
ships **copy-paste Getting Started** docs for the SynergyPlus API.

Stack: Next.js 15 · React 19 · TypeScript · Better Auth · Tailwind CSS · Postgres (`pg`).

## What's inside

| Page | Path | Purpose |
|---|---|---|
| Login | `/login` | Magic-link sign-in, restricted to `@urbanflow.co` / `@nus.edu.sg`. |
| Dashboard | `/dashboard` | Landing: key counts, API endpoint, quick actions, empty states. |
| API Keys | `/keys` | Create a key (raw shown **once**), list (masked), revoke. |
| Getting Started | `/getting-started` | curl + Python SDK examples that submit a simulation. |

Dark mode is the default look, with a light theme toggle.

## How it connects to the platform

- Connects to the **same Postgres** as the platform (`DATABASE_URL`, CONTRACT §6).
- **Better Auth owns its own tables** in a separate **`auth`** schema (CONTRACT §2).
  The portal's own data lives in the platform **`app`** schema.
- On login the portal **upserts `app.users`** by email and treats that `uuid` as the
  canonical **`user_id`** the rest of the system uses. API keys are written to
  **`app.api_keys`** with that `user_id`.
- `key_hash = sha256 hex of the raw key` — exactly how the Go apiserver validates a
  presented key (CONTRACT §3). The raw key is **never stored**.

Raw keys look like `sp_live_<48 hex chars>`.

## Prerequisites

- Node 24 + npm 11.
- A reachable Postgres with the platform schema applied
  (`db/migrations/0001_init.sql`) and the Better Auth schema applied (below).

## Setup

```bash
cd portal
npm install
cp .env.example .env.local       # then edit values

# 1) Apply the platform schema (from repo root, once):
#    psql "$DATABASE_URL" -f db/migrations/0001_init.sql

# 2) Apply the Better Auth schema (creates the `auth` schema + tables):
psql "$DATABASE_URL" -f better-auth-schema.sql
# `npm run auth:generate` re-emits the table DDL from src/lib/auth.ts; the
# committed file additionally prepends `CREATE SCHEMA IF NOT EXISTS auth;` +
# `SET search_path TO auth, public;` so the tables land in the auth schema —
# keep those two lines at the top if you regenerate.

npm run dev                      # serves on http://localhost:3000
```

`npm run build` produces a standalone production build; `npm start` serves it.

## Dev login flow (no mailbox required)

Local dev has **no SMTP**, so email delivery is stubbed:

1. Enter an allowed-domain email on `/login` and submit.
2. Better Auth's `sendMagicLink` callback **prints the link + token to the server
   console** (look for `[portal] Magic link for …`).
3. **And** (dev only) the same link is surfaced in the UI — the "Check your inbox"
   screen shows a **Sign in now →** button. Click it; you're in.

This is controlled by `PORTAL_DEV_LOGIN`. **Security: it is fail-closed** — OFF
unless `PORTAL_DEV_LOGIN=1` is set explicitly, so a built image never exposes the
backdoor by accident (anyone who can reach the portal with it on can log in as any
allowed-domain user). Leave it unset in any deploy reachable beyond localhost; with
it off the portal delivers links over SMTP via `src/lib/auth.ts`'s `sendMagicLink`.

Non-allowed domains are rejected **before any link is generated** with:
`Access is restricted to @urbanflow.co and @nus.edu.sg email addresses.`

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://synergy:synergy@localhost:5432/synergy?sslmode=disable` | Shared platform Postgres (CONTRACT §6). |
| `BETTER_AUTH_SECRET` | dev placeholder | Session signing secret. **Required in prod** — the portal refuses to start if it's unset, <32 chars, or a known placeholder (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Portal base URL used for magic-link generation. |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8090` | API gateway base URL shown in Getting Started. |
| `PORTAL_DEV_LOGIN` | off (fail-closed) | Set to `1` to surface the magic link in the UI for local testing. Never set beyond localhost. |
| `ALLOWED_EMAIL_DOMAINS` | _none_ (fail-closed) | Comma-separated email domains allowed to sign in (ADR-0009), e.g. `urbanflow.co,nus.edu.sg`. Unset blocks all logins. |

## Docker

```bash
docker build -t synergyplus-portal ./portal
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://synergy:synergy@host.docker.internal:5432/synergy?sslmode=disable" \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL="http://localhost:3000" \
  -e NEXT_PUBLIC_API_BASE_URL="http://localhost:8090" \
  synergyplus-portal
```

The image uses Next.js standalone output. In `deploy/docker-compose.yml` the portal
service reaches Postgres at `postgres:5432` per CONTRACT §6.

## Layout

```
portal/
  src/
    app/
      login/                  magic-link login UI (+ dev link surfacing)
      (app)/                  authed shell (sidebar); requires a session
        dashboard/  keys/  getting-started/
      api/
        auth/[...all]/        Better Auth handler
        keys/  keys/[id]/     create / list / revoke (writes app.api_keys)
        dev/last-link/        dev-only: surface the last magic link
    components/               Sidebar, CopyButton, CodeBlock, ThemeToggle, Logo
    lib/
      auth.ts                 Better Auth: domain allow-list + magic link
      api-keys.ts             key generation + sha256 hashing + CRUD
      db.ts                   pg pool + app.users upsert
      session.ts              resolve canonical user_id from the session
      env.ts                  env config + allowed domains
  better-auth-schema.sql      apply once to create the auth schema/tables
  Dockerfile  .env.example
```
