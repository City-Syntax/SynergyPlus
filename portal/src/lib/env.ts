/**
 * Centralized environment configuration for the portal.
 * All values are read on the server only.
 */

export const ALLOWED_DOMAINS = ["urbanflow.co", "nus.edu.sg"] as const;

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
