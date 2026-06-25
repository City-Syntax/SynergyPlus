import { Pool } from "pg";
import { env } from "./env";

/**
 * A single shared pg Pool to the platform Postgres (CONTRACT §6).
 * Better Auth uses this same pool for its `auth` schema tables; the portal uses
 * it directly to upsert `app.users` and manage `app.api_keys`.
 *
 * In dev, Next.js hot-reload re-evaluates modules; cache the pool on globalThis
 * to avoid exhausting connections.
 */
const globalForDb = globalThis as unknown as { __spPool?: Pool };

export const pool: Pool =
  globalForDb.__spPool ??
  new Pool({
    connectionString: env.databaseUrl,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__spPool = pool;
}

/**
 * Resolve the canonical platform `user_id` for an email by upserting into
 * `app.users`. This is the uuid the rest of SynergyPlus uses as `user_id`
 * (CONTRACT §2). Idempotent on the unique email.
 */
export async function upsertAppUser(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app.users (email)
     VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [normalized],
  );
  return rows[0].id;
}
