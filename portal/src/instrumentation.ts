/**
 * Next.js instrumentation: runtime startup checks.
 *
 * register() runs ONCE when the portal server process boots (not at build time,
 * and not in the Edge runtime), which makes it the right place to fail-closed on
 * insecure configuration before the app serves a single request.
 */

// Known throwaway secrets shipped as defaults/placeholders across the repo. If
// any of these reaches a running server, session tokens are signed with a value
// an attacker can read from the source tree → trivial session forgery (audit #6).
const PLACEHOLDER_SECRETS = new Set([
  "dev-only-insecure-secret-change-me-0123456789abcdef",
  "dev-secret-change-me-to-a-long-random-string",
  "change-me-to-a-long-random-string-min-32-chars",
  "build-time-placeholder-secret-please-override",
]);

export async function register() {
  // Only the Node.js server runtime; skip Edge and any build-time evaluation.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  const weak = secret.length < 32 || PLACEHOLDER_SECRETS.has(secret);
  if (!weak) return;

  const message =
    "BETTER_AUTH_SECRET is unset or a known placeholder. Sessions are signed " +
    "with it, so a known value allows session forgery. Set a unique 32+ char " +
    "secret (e.g. `openssl rand -base64 32`).";

  // Fail-closed in production: refuse to start rather than serve forgeable
  // sessions. In dev, warn loudly but allow `npm run dev` to keep working.
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[portal] refusing to start: ${message}`);
  }
  // eslint-disable-next-line no-console
  console.warn(`[portal] WARNING: ${message} (allowed in dev only)`);
}
