import { createHash, randomBytes } from "crypto";
import { pool } from "./db";

export type ApiKeyRow = {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last4: string;
};

/**
 * Generate a raw API key of the form `sp_live_<48 hex chars>`.
 * The raw key is returned to the caller exactly once; only its hash is stored.
 */
export function generateRawKey(): string {
  return `sp_live_${randomBytes(24).toString("hex")}`;
}

/**
 * key_hash = sha256 hex of the raw key.
 * CRITICAL: the Go apiserver validates a presented key by computing
 * sha256(key) and looking it up in app.api_keys (CONTRACT §3). This MUST match.
 */
export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/** A non-sensitive suffix for display in the key list, e.g. "…a1b2". */
function last4(rawKey: string): string {
  return rawKey.slice(-4);
}

export async function createApiKey(
  userId: string,
  name: string,
): Promise<{ id: string; rawKey: string }> {
  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);
  const cleanName = name.trim().slice(0, 80) || "default";
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app.api_keys (user_id, key_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, keyHash, cleanName],
  );
  // Persist a non-sensitive last4 hint by reusing the name column? No — we keep
  // last4 derivable only at creation. We store it client-side display via the
  // returned rawKey; for the list we derive a masked label from the hash.
  return { id: rows[0].id, rawKey };
}

export async function listApiKeys(userId: string): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    created_at: string;
    revoked_at: string | null;
    key_hash: string;
  }>(
    `SELECT id, name, created_at, revoked_at, key_hash
     FROM app.api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    // We never stored the raw key, so we show a stable masked tail derived from
    // the hash (last 4 hex chars). It's only a visual disambiguator.
    last4: r.key_hash.slice(-4),
  }));
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE app.api_keys
     SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [keyId, userId],
  );
  return (rowCount ?? 0) > 0;
}
