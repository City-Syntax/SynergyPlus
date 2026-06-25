#!/usr/bin/env bash
# QA-4: Per-user cap. Lower SP_PER_USER_CAP on a runner pool and flood one
# user's queue; verify concurrent 'running' for that user never exceeds the cap.
set -euo pipefail
cd "$(dirname "$0")/.."
source qa/lib.sh

CAP="${CAP:-3}"
NSLOW="${NSLOW:-6}"   # number of slow runners (each could claim 1 if cap allowed)
NSIMS="${NSIMS:-12}"

echo "== QA-4 per-user cap=$CAP. Launch $NSLOW slow runners (8s each) with cap=$CAP =="
$COMPOSE up -d --scale runner=0 >/dev/null 2>&1
docker rm -f $(docker ps -aq --filter "name=qa-cap-runner") >/dev/null 2>&1 || true

for i in $(seq 1 "$NSLOW"); do
  docker run -d --name "qa-cap-runner-$i" --network synergyplus_default \
    -e DATABASE_URL="postgres://synergy:synergy@postgres:5432/synergy?sslmode=disable" \
    -e S3_ENDPOINT="http://minio:9000" -e S3_REGION=us-east-1 \
    -e S3_ACCESS_KEY=synergy -e S3_SECRET_KEY=synergypass \
    -e S3_BUCKET_MODELS=models -e S3_BUCKET_WEATHER=weather -e S3_BUCKET_RESULTS=results \
    -e SP_FAKE_ENGINE=1 -e SP_FAKE_ENGINE_SECONDS=8 \
    -e SP_ENGINE_VERSION=24.1.0 -e SP_LEASE_SECONDS=90 -e SP_HEARTBEAT_SECONDS=30 \
    -e SP_PER_USER_CAP="$CAP" -e SP_RUNNER_ID="qa-cap-runner-$i" \
    synergyplus-runner >/dev/null
done
sleep 3

SEED="cap-$(date +%s)-$$"
echo "== flooding $NSIMS sims for the single demo user =="
for i in $(seq 1 "$NSIMS"); do
  msha=$(printf 'cap-%s-%02d' "$SEED" "$i" | shasum -a 256 | cut -d' ' -f1)
  wsha=$(printf 'capw-%s-%02d' "$SEED" "$i" | shasum -a 256 | cut -d' ' -f1)
  submit_sim "24.1.0" "s3://models/sample/baseline.idf" "s3://weather/sample/chicago.epw" "$msha" "$wsha" 1 >/dev/null
done

echo "== sampling concurrent 'running' count for ~15s (cap=$CAP) =="
MAX=0
for _ in $(seq 1 30); do
  r=$(psql_t "SELECT count(*) FROM app.simulations WHERE state='running' AND user_id=(SELECT id FROM app.users WHERE email='demo@urbanflow.co')")
  [ "$r" -gt "$MAX" ] && MAX=$r
  printf "  running=%s (peak=%s)\n" "$r" "$MAX"
  sleep 0.5
done
echo "== PEAK concurrent running for user = $MAX (cap=$CAP). PASS if PEAK <= $CAP =="

echo "== cleanup =="
docker rm -f $(docker ps -aq --filter "name=qa-cap-runner") >/dev/null 2>&1 || true
$COMPOSE up -d --scale runner=2 >/dev/null 2>&1
