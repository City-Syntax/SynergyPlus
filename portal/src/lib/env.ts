/**
 * Centralized environment configuration for the portal.
 * All values are read on the server only.
 */

// Email domains permitted to sign in (ADR-0009), configured at runtime via
// ALLOWED_EMAIL_DOMAINS (comma-separated, e.g. "urbanflow.co,nus.edu.sg").
// Fail-closed: an empty/unset list permits no one, so a misconfigured deploy
// blocks logins rather than opening them up.
export const ALLOWED_DOMAINS: string[] = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Re-exported for server callers; the implementation is env-free (see
// ./allowed-domains) so client components can import it directly.
export { allowedDomainsLabel } from "./allowed-domains";

export const env = {
  // Shared Postgres (CONTRACT §6). Better Auth + the app schema live here.
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://synergy:synergy@localhost:5432/synergy?sslmode=disable",

  // Base URL of the portal itself (used by Better Auth for link generation).
  baseUrl: process.env.BETTER_AUTH_URL || "http://localhost:3000",

  // Secret used by Better Auth to sign sessions. A dev default is provided so
  // `npm run dev` works out of the box; ALWAYS override in production.
  authSecret:
    process.env.BETTER_AUTH_SECRET ||
    "dev-only-insecure-secret-change-me-0123456789abcdef",

  // Public base URL of the SynergyPlus API gateway (CONTRACT §3) — shown in the
  // Getting Started examples so researchers copy a working command.
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090",

  // When true, magic-link login codes are surfaced in the UI (no real mailbox
  // needed). Defaults to on unless NODE_ENV === 'production'.
  devLoginEnabled:
    (process.env.PORTAL_DEV_LOGIN ?? (process.env.NODE_ENV !== "production" ? "1" : "0")) ===
    "1",
} as const;

export const apiBaseUrlPublic =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090";
