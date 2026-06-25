import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { Pool } from "pg";
import { ALLOWED_DOMAINS, allowedDomainsLabel, env } from "./env";
import { recordDevLink } from "./dev-magic-link";

// The access-restriction message, derived from the configured allow-list.
function restrictionMessage(): string {
  const label = allowedDomainsLabel(ALLOWED_DOMAINS);
  return label
    ? `Access is restricted to ${label} email addresses.`
    : "Access is restricted to approved email addresses.";
}

/**
 * Better Auth owns its own tables. We point it at the shared platform Postgres
 * but isolate its tables under the `auth` schema (CONTRACT §2) by setting the
 * search_path on its dedicated pool. The portal's own queries (app.users,
 * app.api_keys) go through src/lib/db.ts with the default search_path.
 */
const authPool = new Pool({
  connectionString: env.databaseUrl,
  max: 5,
});

// Ensure the auth schema exists and Better Auth's tables land in it.
authPool.on("connect", (client) => {
  client.query("SET search_path TO auth, public").catch(() => {
    /* best-effort; schema is created on boot below */
  });
});

function isAllowedEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && ALLOWED_DOMAINS.includes(domain);
}

export const auth = betterAuth({
  baseURL: env.baseUrl,
  secret: env.authSecret,
  database: authPool,
  // We don't use password auth; magic link is the only flow.
  emailAndPassword: { enabled: false },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
  },
  plugins: [
    magicLink({
      expiresIn: 60 * 10, // 10 minutes
      // Only existing OR allowed-domain users; we create on first link.
      disableSignUp: false,
      sendMagicLink: async ({ email, token, url }) => {
        // Local dev: no SMTP. Log to console and stash for the UI.
        // eslint-disable-next-line no-console
        console.log(
          `\n[portal] Magic link for ${email}\n          ${url}\n          (token: ${token})\n`,
        );
        if (env.devLoginEnabled) {
          recordDevLink({ email, url, token, at: Date.now() });
        }
        // In production you would send an email here instead.
      },
    }),
  ],
  hooks: {
    /**
     * Domain allow-list (ADR-0009): reject any magic-link request whose email
     * domain is not in the configured allow-list (ALLOWED_EMAIL_DOMAINS), with a
     * clear message, before a link is ever generated.
     */
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/magic-link") {
        const email = ctx.body?.email;
        if (!isAllowedEmail(email)) {
          throw new APIError("BAD_REQUEST", { message: restrictionMessage() });
        }
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        // Defense in depth: even if a sign-up slips through, enforce the domain.
        before: async (user) => {
          if (!isAllowedEmail(user.email)) {
            throw new APIError("BAD_REQUEST", { message: restrictionMessage() });
          }
          return { data: user };
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
