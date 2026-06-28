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

  // Dev magic-link backdoor: surfaces sign-in links in the UI/console with no
  // mailbox, which means anyone who can reach the portal can log in as any
  // allowed-domain user. SECURITY (audit #2): fail-CLOSED — OFF unless
  // PORTAL_DEV_LOGIN=1 is set explicitly. There is deliberately no NODE_ENV-based
  // default, so a built image can never enable it by accident; a real deploy just
  // never sets the flag, and the local compose stack opts in explicitly while
  // binding the portal to localhost.
  devLoginEnabled: process.env.PORTAL_DEV_LOGIN === "1",

  // Sender shown on outgoing magic-link mail. RFC-5322 form is accepted, e.g.
  // "SynergyPlus <noreply@yourdomain.com>".
  mailFrom: process.env.MAIL_FROM || "SynergyPlus <noreply@localhost>",

  // Generic SMTP transport for production magic-link delivery. Provider-agnostic
  // by design (point at SES SMTP, Resend, Postmark, a self-hosted relay, …) so a
  // forker can swap providers with config alone — no code or image rebuild.
  // Left unset in dev: when devLoginEnabled is on, the link is surfaced in the UI
  // instead of mailed (see ./mailer + ./auth), so no SMTP server is required.
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || "587"),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    // Implicit TLS on 465; STARTTLS on 587/2525. Override with SMTP_SECURE=1/0.
    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "1"
      : Number(process.env.SMTP_PORT || "587") === 465,
  },
} as const;

export const apiBaseUrlPublic =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090";
