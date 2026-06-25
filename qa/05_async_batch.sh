#!/usr/bin/env bash
# QA-5: Async batch (>100) rollup race (H-1). Submit a 130-variant batch
# (async expanding path), wait until every child sim is terminal, then compare
# the batch rollup against ground truth. BUG: batch stays 'running' with
# succeeded = total-1/-2 forever.
set -euo pipefail
cd "$(dirname "$0")/.."
source qa/lib.sh

TRIALS="${TRIALS:-3}"
NVAR="${NVAR:-130}"
$COMPOSE up -d --scale runner=4 >/dev/null 2>&1

for t in $(seq 1 "$TRIALS"); do
  SEED="async-$(date +%s)-$t-$$"
  variants=""
  for i in $(seq 1 "$NVAR"); do
    sha=$(printf '%s-%03d' "$SEED" "$i" | shasum -a 256 | cut -d' ' -f1)
    variants="$variants{\"model\":{\"ref\":\"s3://models/sample/baseline.idf\",\"sha256\":\"$sha\"}},"
  done
  variants="${variants%,}"
  wsha=$(printf 'w-%s' "$SEED" | shasum -a 256 | cut -d' ' -f1)
  resp=$(curl -s -H "Authorization: Bearer $KEY" -X POST "$API/v1/batches" \
    -d '{"engineVersion":"24.1.0","weather":{"ref":"s3://weather/sample/chicago.epw","sha256":"'"$wsha"'"},"variants":['"$variants"']}')
  BID=$(echo "$resp" | sed -E 's/.*"batchId":"([^"]+)".*/\1/')

  for _ in $(seq 1 90); do
    nt=$(psql_t "SELECT count(*) FROM app.simulations WHERE batch_id='$BID' AND state IN ('queued','running')")
    [ "$nt" = "0" ] && break
    sleep 2
  done
  sleep 3

  bstate=$(psql_t "SELECT state||'|succ='||succeeded||'|total='||total FROM app.batches WHERE id='$BID'")
  real=$(psql_t "SELECT count(*) FILTER (WHERE state='succeeded')||'/'||count(*) FROM app.simulations WHERE batch_id='$BID'")
  echo "trial $t: batch=[$bstate]  actual_sims=[$real]  (BUG if batch != done/succ=total)"
done

$COMPOSE up -d --scale runner=2 >/dev/null 2>&1
