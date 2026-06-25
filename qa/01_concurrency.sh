#!/usr/bin/env bash
# QA-1: Concurrency / no double-claim. Submit N sims, scale to 6 runners,
# verify each sim runs exactly once. Detects double-claims via attempts and
# duplicate result writes.
set -euo pipefail
cd "$(dirname "$0")/.."
source qa/lib.sh

N="${N:-30}"
SEED="${SEED:-$(date +%s)-$$}"
echo "== QA-1 concurrency: submitting $N sims with UNIQUE inputs (seed=$SEED, forces real runs) =="

# Unique model refs so each is a distinct content_hash -> no cache short-circuit.
IDS=()
for i in $(seq 1 "$N"); do
  # Unique fake sha per sim so each requires an actual run.
  msha=$(printf 'qa1-model-%s-%03d' "$SEED" "$i" | shasum -a 256 | cut -d' ' -f1)
  wsha=$(printf 'qa1-weather-%s-%03d' "$SEED" "$i" | shasum -a 256 | cut -d' ' -f1)
  resp=$(submit_sim "24.1.0" "s3://models/sample/baseline.idf" "s3://weather/sample/chicago.epw" "$msha" "$wsha" 1)
  id=$(echo "$resp" | sed -E 's/.*"id":"([^"]+)".*/\1/')
  IDS+=("$id")
done
echo "submitted ${#IDS[@]} sims"

# Build a SQL id-list 'a','b','c'
join_sql() { local out=""; for x in "$@"; do out="$out,'$x'"; done; echo "${out:1}"; }
idlist="$(join_sql "${IDS[@]}")"

echo "== scaling runners to 6 =="
$COMPOSE up -d --scale runner=6 >/dev/null 2>&1
echo "waiting for drain..."

# Wait until all our sims are terminal (max ~120s).
for _ in $(seq 1 60); do
  remaining=$(psql_t "SELECT count(*) FROM app.simulations WHERE id IN ($idlist) AND state IN ('queued','running')")
  echo "  not-terminal: $remaining"
  [ "$remaining" = "0" ] && break
  sleep 3
done

echo "== RESULTS =="
echo "-- state distribution --"
psql_c "SELECT state,count(*) FROM app.simulations WHERE id IN ($idlist) GROUP BY state;"
echo "-- attempts distribution (attempts>1 means a re-claim happened) --"
psql_c "SELECT attempts,count(*) FROM app.simulations WHERE id IN ($idlist) GROUP BY attempts ORDER BY attempts;"
echo "-- distinct runner_ids that touched these (informational) --"
psql_c "SELECT runner_id, count(*) FROM app.simulations WHERE id IN ($idlist) GROUP BY runner_id;"
echo "-- double-claim check: any content_hash with >1 result row? (PK makes this impossible, but check sim rows sharing a hash) --"
psql_c "SELECT content_hash, count(*) FROM app.simulations WHERE id IN ($idlist) GROUP BY content_hash HAVING count(*)>1;"
