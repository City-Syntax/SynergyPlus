"use client";

import { useEffect, useState } from "react";
import type { DashboardData, RunningSimulation } from "@/lib/dashboard";

const POLL_MS = 5000;

export function LiveActivity({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState<DashboardData>(initial);
  const [stale, setStale] = useState(false);
  // Ticks every second so "running for Xs" counts up between polls.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch("/api/dashboard", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as DashboardData;
        if (alive) {
          setData(next);
          setStale(false);
        }
      } catch {
        if (alive) setStale(true);
      }
    }

    const pollId = setInterval(poll, POLL_MS);
    const tickId = setInterval(() => alive && setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  const { metrics, runningSimulations, cluster } = data;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Pulse active={metrics.running > 0} />
          Activity
        </h2>
        <span className="text-xs text-muted">
          Cluster:{" "}
          <span className="font-medium text-fg">{cluster.running}</span> running
          {" · "}
          <span className="font-medium text-fg">{cluster.queued}</span> queued
          {stale && <span className="ml-2 text-amber-400">· reconnecting…</span>}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Running" value={String(metrics.running)} tone="teal" />
        <Metric label="Queued" value={String(metrics.queued)} tone="muted" />
        <Metric label="Done (24h)" value={String(metrics.succeeded24h)} tone="green" />
        <Metric
          label="Avg runtime"
          value={metrics.avgRunSeconds === null ? "—" : formatDuration(metrics.avgRunSeconds)}
          tone="muted"
        />
      </div>

      <div className="rounded-xl border border-border bg-panel">
        <div className="border-b border-border px-4 py-2.5 text-xs font-medium text-muted">
          Running now
        </div>
        {runningSimulations.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            {metrics.queued > 0
              ? `No simulations running — ${metrics.queued} queued, waiting for a runner.`
              : "No simulations running."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {runningSimulations.map((sim) => (
              <SimulationRow key={sim.id} sim={sim} now={now} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SimulationRow({ sim, now }: { sim: RunningSimulation; now: number }) {
  const elapsed = sim.startedAt ? Math.max(0, (now - Date.parse(sim.startedAt)) / 1000) : null;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs text-muted">{sim.id.slice(0, 8)}</span>
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">
            EnergyPlus {sim.engineVersion}
          </span>
          {sim.attempts > 1 && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-400">
              attempt {sim.attempts}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">
          {sim.runnerId ? `runner ${sim.runnerId}` : "assigning runner…"}
          {sim.batchId && " · batch"}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm tabular-nums text-accent-teal">
          {elapsed === null ? "—" : formatDuration(elapsed)}
        </div>
        <div className="text-[11px] text-muted">running</div>
      </div>
    </li>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "teal" | "green" | "muted";
}) {
  const toneClass =
    tone === "teal" ? "text-accent-teal" : tone === "green" ? "text-accent-green" : "text-fg";
  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function Pulse({ active }: { active: boolean }) {
  if (!active) return <span className="h-2 w-2 rounded-full bg-border" aria-hidden />;
  return (
    <span className="relative flex h-2 w-2" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-teal opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-teal" />
    </span>
  );
}

function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
