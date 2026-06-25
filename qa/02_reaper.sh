#!/usr/bin/env bash
# QA-2: Reaper / lease (ADR-0003). Start a runner with a long fake-engine run,
# kill it mid-run, verify the reaper requeues (attempts++) and another runner
# finishes it. Lease is 90s by default; we shorten it for this test runner so
# the reap happens quickly.
set -euo pipefail
cd "$(dirname "$0")/.."
source qa/lib.sh

SEED="reaper-$(date +%s)-$$"
echo "== QA-2 reaper: launching a slow runner (60s fake run, short 10s lease) =="

# A dedicated slow runner with a SHORT lease so reaping is fast to observe.
# 60s run >> 10s lease, and heartbeat is disabled (interval huge) so the lease
# WILL expire if we kill it. NOTE: with heartbeat alive the lease never expires;
# to test reaping of a *dead* runner we kill the container (heartbeat dies too).
docker run -d --name qa-slow-runner \
  --network synergyplus_default \
  -e DATABASE_URL="postgres://synergy:synergy@postgres:5432/synergy?sslmode=disable" \
  -e S3_ENDPOINT="http://minio:9000" -e S3_REGION=us-east-1 \
  -e S3_ACCESS_KEY=synergy -e S3_SECRET_KEY=synergypass \
  -e S3_BUCKET_MODELS=models -e S3_BUCKET_WEATHER=weather -e S3_BUCKET_RESULTS=results \
  -e SP_FAKE_ENGINE=1 -e SP_FAKE_ENGINE_SECONDS=60 \
  -e SP_ENGINE_VERSION=24.1.0 \
  -e SP_LEASE_SECONDS=10 -e SP_HEARTBEAT_SECONDS=30 \
  -e SP_RUNNER_ID=qa-slow-runner \
  synergyplus-runner >/dev/null
echo "slow runner started (id=qa-slow-runner)"
sleep 3

# Submit one sim that ONLY the slow runner can grab quickly. To bias it, scale
# the normal pool to 0 first so the slow runner is the sole claimant.
echo "== scaling normal runners to 0 so the slow runner claims it =="
$COMPOSE up -d --scale runner=0 >/dev/null 2>&1
sleep 2

msha=$(printf 'm-%s' "$SEED" | shasum -a 256 | cut -d' ' -f1)
wsha=$(printf 'w-%s' "$SEED" | shasum -a 256 | cut -d' ' -f1)
resp=$(submit_sim "24.1.0" "s3://models/sample/baseline.idf" "s3://weather/sample/chicago.epw" "$msha" "$wsha" 2)
SIM=$(echo "$resp" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "submitted sim=$SIM"

echo "waiting for slow runner to claim it (state=running)..."
for _ in $(seq 1 20); do
  st=$(psql_t "SELECT state||'|'||attempts||'|'||COALESCE(runner_id,'-') FROM app.simulations WHERE id='$SIM'")
  echo "  $st"
  [[ "$st" == running* ]] && break
  sleep 1
done

echo "== KILLING the slow runner mid-run (simulating partition/crash) =="
docker kill qa-slow-runner >/dev/null
KILL_T=$(date +%s)
echo "killed at $(date)"

echo "== bringing normal pool back (2 runners) to finish the requeued sim =="
$COMPOSE up -d --scale runner=2 >/dev/null 2>&1

echo "watching for reaper requeue + completion (lease=10s, reaper every 15s)..."
for _ in $(seq 1 40); do
  st=$(psql_t "SELECT state||'|attempts='||attempts||'|'||COALESCE(runner_id,'-')||'|lease='||COALESCE(lease_expires_at::text,'-') FROM app.simulations WHERE id='$SIM'")
  now=$(date +%s)
  echo "  [+$((now-KILL_T))s] $st"
  state=$(echo "$st" | cut -d'|' -f1)
  [[ "$state" == succeeded || "$state" == failed ]] && break
  sleep 3
done

echo "== FINAL =="
psql_c "SELECT id,state,attempts,runner_id,error FROM app.simulations WHERE id='$SIM';"

echo "== cleanup slow runner container =="
docker rm -f qa-slow-runner >/dev/null 2>&1 || true
