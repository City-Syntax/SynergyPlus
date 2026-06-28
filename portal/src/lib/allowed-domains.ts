// Pure helpers for the email-domain allow-list, with no environment access —
// safe to import from client components (which receive the list as a prop) as
// well as the server. The list itself is configured server-side in env.ts from
// ALLOWED_EMAIL_DOMAINS.

/**
 * Returns true when the email's domain (case-insensitive) appears in the
 * provided allow-list. Both server enforcement (auth.ts) and client UX
 * (LoginForm.tsx) delegate here so the normalisation can never drift.
 */
export function isEmailDomainAllowed(
  email: string,
  domains: readonly string[],
): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && domains.includes(domain);
}

/**
 * Human-readable label for a set of allowed email domains, e.g. "@a.com or
 * @b.com". Returns null when the list is empty so callers can fall back to
 * generic wording.
 */
export function allowedDomainsLabel(
  domains: readonly string[],
): string | null {
  const at = domains.map((d) => `@${d}`);
  if (at.length === 0) return null;
  if (at.length === 1) return at[0];
  if (at.length === 2) return `${at[0]} or ${at[1]}`;
  return `${at.slice(0, -1).join(", ")}, or ${at[at.length - 1]}`;
}
