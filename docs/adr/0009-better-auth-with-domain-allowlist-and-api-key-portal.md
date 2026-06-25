# Self-hosted Better Auth with an email-domain allow-list and an API-key developer portal

Authentication is a self-hosted **Better Auth** service running in-cluster (its own
pod), rather than federating to an external IdP. Login is restricted to the
**`@urbanflow.co`** and **`@nus.edu.sg`** email domains — anyone with such an email is
a User. A simple **developer portal** lets logged-in users mint and revoke **API
keys**, which are the credential the SDK/CLI present; the SynergyPlus API validates a
key and stamps the resolved `user_id` on submissions. Chosen "for now" as the simple,
self-contained option.

Status: accepted

## Considered options

- **OIDC federation to the lab IdP** (Google Workspace / university SSO) — trustworthy
  and no credential store, but more upfront integration and an external runtime
  dependency. Deferred in favour of a self-contained in-cluster service; swappable later
  without changing the `user_id` contract.
- **Per-user API keys with no portal** — no self-service; keys issued by hand.

## Consequences

- Introduces a TypeScript/Node component. The stack is now **Go** (operator/apiserver) +
  **Python** (worker/SDK) + **TypeScript** (auth/portal) — officially polyglot.
- Better Auth needs a datastore; reuse the platform Postgres (separate schema) so the
  apiserver can validate a presented API key by hashed-key lookup locally.
- Email-domain restriction is enforced at login, so every issued API key already maps to
  an allowed User; the apiserver resolves `user_id` from the key.
- "For now" — a deliberate simple choice, replaceable by OIDC federation later.
