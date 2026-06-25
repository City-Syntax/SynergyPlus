import { pool } from "./db";

/**
 * Read-only dashboard queries over the shared platform Postgres (CONTRACT §6).
 *
 * The portal reads `app.simulations` directly rather than going through the
 * apiserver: it already holds a pool to the same database, and these are cheap
 * aggregate/count reads backed by the partial indexes on
 * `state = 'queued'` / `state = 'running'` (see 0001_init.sql). Per-user reads
 * filter on `user_id`; cluster health is global (all tenants) for context.
 */

export type JobMetrics = {
  /** The user's simulations currently running. */
  running: number;
  /** The user's simulations waiting in the queue. */
  queued: number;
  /** Finished successfully in the last 24h. */
  succeeded24h: number;
  /** Failed in the last 24h. */
  failed24h: number;
  /** Mean wall-clock seconds of the user's successful runs in the last 24h. */
  avgRunSeconds: number | null;
};

export type RunningJob = {
  id: string;
  engineVersion: string;
  runnerId: string | null;
  /** ISO timestamp the run started, or null if not yet stamped. */
  startedAt: string | null;
  attempts: number;
  batchId: string | null;
};

/** Cluster-wide counts (all users) — shown as ambient cluster health. */
export type ClusterHealth = {
  running: number;
  queued: number;
};

export type DashboardData = {
  metrics: JobMetrics;
  runningJobs: RunningJob[];
  cluster: ClusterHealth;
};

const RUNNING_JOBS_LIMIT = 25;

async function userMetrics(userId: string): Promise<JobMetrics> {
  const { rows } = await pool.query<{
    running: string;
    queued: string;
    succeeded_24h: string;
    failed_24h: string;
    avg_run_seconds: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE state = 'running')                                   AS running,
       count(*) FILTER (WHERE state = 'queued')                                    AS queued,
       count(*) FILTER (WHERE state = 'succeeded' AND finished_at > now() - interval '24 hours') AS succeeded_24h,
       count(*) FILTER (WHERE state = 'failed'    AND finished_at > now() - interval '24 hours') AS failed_24h,
       avg(extract(epoch FROM (finished_at - started_at)))
         FILTER (WHERE state = 'succeeded'
                 AND finished_at > now() - interval '24 hours'
                 AND started_at IS NOT NULL)                                       AS avg_run_seconds
     FROM app.simulations
     WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return {
    running: Number(r.running),
    queued: Number(r.queued),
    succeeded24h: Number(r.succeeded_24h),
    failed24h: Number(r.failed_24h),
    avgRunSeconds: r.avg_run_seconds === null ? null : Number(r.avg_run_seconds),
  };
}

async function runningJobs(userId: string): Promise<RunningJob[]> {
  const { rows } = await pool.query<{
    id: string;
    engine_version: string;
    runner_id: string | null;
    started_at: Date | null;
    attempts: number;
    batch_id: string | null;
  }>(
    `SELECT id, engine_version, runner_id, started_at, attempts, batch_id
       FROM app.simulations
      WHERE user_id = $1 AND state = 'running'
      ORDER BY started_at DESC NULLS LAST
      LIMIT $2`,
    [userId, RUNNING_JOBS_LIMIT],
  );
  return rows.map((r) => ({
    id: r.id,
    engineVersion: r.engine_version,
    runnerId: r.runner_id,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    attempts: r.attempts,
    batchId: r.batch_id,
  }));
}

async function clusterHealth(): Promise<ClusterHealth> {
  // Two index-only counts (partial indexes on state) rather than one full scan.
  const [running, queued] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.simulations WHERE state = 'running'`,
    ),
    pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.simulations WHERE state = 'queued'`,
    ),
  ]);
  return {
    running: Number(running.rows[0].count),
    queued: Number(queued.rows[0].count),
  };
}

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const [metrics, jobs, cluster] = await Promise.all([
    userMetrics(userId),
    runningJobs(userId),
    clusterHealth(),
  ]);
  return { metrics, runningJobs: jobs, cluster };
}
