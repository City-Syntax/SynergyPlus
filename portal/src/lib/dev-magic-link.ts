/**
 * Dev-only magic-link relay.
 *
 * In local development there is no SMTP server, so Better Auth's `sendMagicLink`
 * callback cannot deliver an email. Instead we:
 *   1. log the link + token to the server console, and
 *   2. stash the most recent link per-email in this in-memory map so the login
 *      UI can surface it (via /api/dev/last-link) for one-click testing.
 *
 * This is gated behind env.devLoginEnabled and is NEVER used in production.
 */

type DevLink = { email: string; url: string; token: string; at: number };

const globalForDev = globalThis as unknown as {
  __spDevLinks?: Map<string, DevLink>;
};

const store: Map<string, DevLink> =
  globalForDev.__spDevLinks ?? new Map<string, DevLink>();
globalForDev.__spDevLinks = store;

export function recordDevLink(link: DevLink): void {
  store.set(link.email.toLowerCase(), link);
}

export function getDevLink(email: string): DevLink | undefined {
  return store.get(email.toLowerCase());
}
