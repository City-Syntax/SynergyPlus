import Link from "next/link";
import { getPortalUser } from "@/lib/session";
import { listApiKeys } from "@/lib/api-keys";
import { apiBaseUrlPublic } from "@/lib/env";

export default async function DashboardPage() {
  const user = (await getPortalUser())!;
  const keys = await listApiKeys(user.userId);
  const activeKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {user.name}
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          Your SynergyPlus developer dashboard — keys, docs, and everything you
          need to run EnergyPlus at scale.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Active API keys" value={String(activeKeys.length)} />
        <Stat label="Total keys" value={String(keys.length)} />
        <Stat label="API endpoint" value={apiBaseUrlPublic} mono />
      </div>

      {activeKeys.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ActionCard
            href="/keys"
            title="Manage API keys"
            body={`You have ${activeKeys.length} active key${activeKeys.length === 1 ? "" : "s"}. Create, copy, or revoke them.`}
          />
          <ActionCard
            href="/getting-started"
            title="Run your first simulation"
            body="Copy-paste curl and Python SDK examples that submit a simulation to the API."
          />
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div
        className={`mt-1 truncate text-lg font-semibold text-fg ${mono ? "font-mono text-sm" : ""}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function ActionCard({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-border bg-panel p-5 transition hover:border-brand/50"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-muted transition group-hover:translate-x-0.5 group-hover:text-brand">
          →
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{body}</p>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-panel p-10 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-brand/12 text-brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="m10.5 12.5 8-8M16 6l2 2M19 3l2 2" />
        </svg>
      </div>
      <h2 className="text-base font-semibold">Create your first API key</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
        An API key authenticates the SDK and CLI against the SynergyPlus API.
        You&apos;ll see the raw key once — store it somewhere safe.
      </p>
      <Link
        href="/keys"
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:opacity-90"
      >
        Create API key →
      </Link>
    </div>
  );
}
