import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashKey } from "@/lib/api-keys";

/**
 * Pins the portal side of the apiserver<->portal API-key hash seam (ADR-0014,
 * CONTRACT §3). The same fixture is consumed by the Go test
 * internal/api/api_key_vectors_test.go, so a typo in either hashKey or
 * HashAPIKey is caught instead of silently 401-ing every key. The sha256
 * digests in the fixture are computed independently of the code under test.
 *
 * Fixture lives at the repo root (testdata/), four levels up from this file:
 *   portal/src/lib -> portal/src -> portal -> <repo root>
 */
type ApiKeyVector = { raw: string; sha256: string };

const fixturePath = join(
  __dirname,
  "..",
  "..",
  "..",
  "testdata",
  "api_key_vectors.json",
);

const vectors: ApiKeyVector[] = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("hashKey matches shared API-key vectors", () => {
  it("loads at least one vector", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors)("hashKey(%j) === expected sha256", ({ raw, sha256 }) => {
    expect(hashKey(raw)).toBe(sha256);
  });
});
