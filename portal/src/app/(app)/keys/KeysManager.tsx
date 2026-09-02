"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { BUTTON_LINK, BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT_TEXT } from "@/components/ui";
import type { ApiKeyRow } from "@/lib/api-keys";

type NewKey = { id: string; name: string; rawKey: string };

export function KeysManager({ initialKeys }: { initialKeys: ApiKeyRow[] }) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<NewKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/keys");
    if (res.ok) {
      const data = await res.json();
      setKeys(data.keys);
    }
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "default" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to create key");
      }
      const data: NewKey = await res.json();
      setNewKey(data);
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Any client using it will stop working immediately.")) {
      return;
    }
    setRevoking(id);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (res.ok) await refresh();
    } finally {
      setRevoking(null);
    }
  }

  const activeKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="space-y-7">
      {/* One-time raw key reveal */}
      {newKey && (
        <div className="rounded-card bg-surface-success p-4">
          <div className="mb-1 flex items-center gap-2 header-medium text-text-success">
            <span className="text-icon-success">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            Key “{newKey.name}” created
          </div>
          <p className="mb-3 text-body-medium text-text-success">
            Copy it now — for security, this is the only time the full key is
            shown. We store only its SHA-256 hash.
          </p>
          <div className="flex items-center gap-2 rounded-control bg-surface p-1.5 inset-ring inset-ring-border">
            <code className="value-mono flex-1 overflow-x-auto whitespace-nowrap px-1.5 text-text">
              {newKey.rawKey}
            </code>
            <CopyButton value={newKey.rawKey} label="Copy key" />
          </div>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className={`mt-3 ${BUTTON_LINK}`}
          >
            I&apos;ve stored it — dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <form
        onSubmit={createKey}
        className="flex flex-col gap-3 rounded-card bg-surface p-4 inset-ring inset-ring-border sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label htmlFor="keyname" className="mb-1.5 block header-subtitle">
            Key name
          </label>
          <input
            id="keyname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. laptop-cli, ci-pipeline"
            maxLength={80}
            className={INPUT_TEXT}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className={BUTTON_PRIMARY}
        >
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>
      {error && (
        <p className="rounded-control bg-surface-critical px-3 py-2 text-body-medium text-text-critical">
          {error}
        </p>
      )}

      {/* List */}
      <div>
        <h2 className="mb-3 header-medium text-text-secondary">
          Your keys{" "}
          <span className="font-normal">
            ({activeKeys.length} active, {keys.length} total)
          </span>
        </h2>

        {keys.length === 0 ? (
          <div className="rounded-card border border-dashed border-border bg-surface p-10 text-center">
            <p className="text-body-normal text-text-secondary">
              No API keys yet. Create one above to start submitting simulations.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-card bg-surface inset-ring inset-ring-border">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between gap-4 px-4 py-3.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-body-normal font-medium text-text">
                      {k.name}
                    </span>
                    <code className="rounded-small bg-surface-tertiary px-1.5 py-0.5 font-mono text-body-small text-text-secondary">
                      #{k.hashTail}
                    </code>
                    {k.revoked_at && (
                      <span className="rounded-full bg-fill-critical-secondary px-2 py-0.5 text-body-small font-semibold uppercase tracking-wide text-text-critical">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-body-medium text-text-secondary">
                    Created {new Date(k.created_at).toLocaleString()}
                    {k.revoked_at &&
                      ` · revoked ${new Date(k.revoked_at).toLocaleString()}`}
                  </div>
                </div>
                {!k.revoked_at && (
                  <button
                    type="button"
                    onClick={() => revoke(k.id)}
                    disabled={revoking === k.id}
                    className={`shrink-0 text-text-secondary not-disabled:hover:text-text-critical ${BUTTON_SECONDARY}`}
                  >
                    {revoking === k.id ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
