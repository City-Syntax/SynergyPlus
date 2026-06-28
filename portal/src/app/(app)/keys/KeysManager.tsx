"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
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
        <div className="rounded-2xl border border-brand/40 bg-brand/[0.06] p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-brand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Key “{newKey.name}” created
          </div>
          <p className="mb-3 text-xs text-muted">
            Copy it now — for security, this is the only time the full key is
            shown. We store only its SHA-256 hash.
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-panel p-2.5">
            <code className="flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[13px] text-fg">
              {newKey.rawKey}
            </code>
            <CopyButton value={newKey.rawKey} label="Copy key" />
          </div>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className="mt-3 text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
          >
            I&apos;ve stored it — dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <form
        onSubmit={createKey}
        className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label htmlFor="keyname" className="mb-1.5 block text-xs font-medium text-muted">
            Key name
          </label>
          <input
            id="keyname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. laptop-cli, ci-pipeline"
            maxLength={80}
            className="w-full rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 text-sm outline-none transition placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/30"
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-60"
        >
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {/* List */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted">
          Your keys{" "}
          <span className="font-normal">
            ({activeKeys.length} active, {keys.length} total)
          </span>
        </h2>

        {keys.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-panel p-10 text-center">
            <p className="text-sm text-muted">
              No API keys yet. Create one above to start submitting simulations.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-panel">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between gap-4 px-4 py-3.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">
                      {k.name}
                    </span>
                    <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                      #{k.hashTail}
                    </code>
                    {k.revoked_at && (
                      <span className="rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
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
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition hover:border-red-500/40 hover:text-red-400 disabled:opacity-60"
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
