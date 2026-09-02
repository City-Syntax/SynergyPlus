import Link from "next/link";
import { getRequiredPortalUser } from "@/lib/session";
import { listApiKeys } from "@/lib/api-keys";
import { getDashboardData } from "@/lib/dashboard";
import { apiBaseUrlPublic } from "@/lib/env";
import { LiveActivity } from "./LiveActivity";
import { BUTTON_PRIMARY } from "@/components/ui";

export default async function DashboardPage() {
  const user = await getRequiredPortalUser();
  const [keys, activity] = await Promise.all([
    listApiKeys(user.userId),
    getDashboardData(user.userId),
  ]);
  const activeKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="header-xlarge">Welcome back, {user.name}</h1>
        <p className="mt-1.5 text-body-large text-text-secondary">
          Your SynergyPlus developer dashboard — keys, docs, and everything you
          need to run EnergyPlus at scale.
        </p>
      </header>

      <LiveActivity initial={activity} />

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
    <div className="rounded-card bg-surface p-4 inset-ring inset-ring-border">
      <div className="text-body-medium font-medium text-text-secondary">
        {label}
      </div>
      <div
        className={`mt-1 truncate ${mono ? "value-mono text-text" : "header-large"}`}
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
      className="group rounded-card bg-surface p-4 transition-colors inset-ring inset-ring-border hover:bg-surface-hover hover:inset-ring-border-hover active:bg-surface-active outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1"
    >
      <div className="flex items-center justify-between">
        <h3 className="header-medium">{title}</h3>
        <span className="text-icon-secondary transition-transform group-hover:translate-x-0.5 group-hover:text-icon">
          →
        </span>
      </div>
      <p className="mt-1.5 text-body-medium text-text-secondary">{body}</p>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-modal border border-dashed border-border bg-surface p-10 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-surface-tertiary text-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="m10.5 12.5 8-8M16 6l2 2M19 3l2 2" />
        </svg>
      </div>
      <h2 className="header-normal">Create your first API key</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-body-large text-text-secondary">
        An API key authenticates the SDK and CLI against the SynergyPlus API.
        You&apos;ll see the raw key once — store it somewhere safe.
      </p>
      <Link
        href="/keys"
        className={`mt-5 ${BUTTON_PRIMARY}`}
      >
        Create API key →
      </Link>
    </div>
  );
}
