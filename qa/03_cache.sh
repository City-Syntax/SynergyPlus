#!/usr/bin/env bash
# QA-3: Cache (ADR-0007/0003). Submit SAME inputs twice WITH sha256:
#   - 1st: runs (queued -> succeeded)
#   - 2nd: immediate cache hit (succeeded, never claimed, attempts=0)
#   - exactly 1 row in app.results for that content_hash
# Then submit WITHOUT sha256: must NOT cache-hit (placeholder hash, runs).
set -euo pipefail
cd "$(dirname "$0")/.."
source qa/lib.sh

$COMPOSE up -d --scale runner=2 >/dev/null 2>&1

# Use the REAL shas of the seeded sample objects. Post-C-1 the runner keys the
# cache on the ACTUAL fetched bytes, so the sha the client sends must match the
# object (the SDK does this via ArtifactRef.from_file). Synthetic shas no longer
# drive the stored hash — that hardening is the C-1 fix, not a bug. With real
# sample bytes #1 may already be cached from a prior run; the cache assertion is
# that #2 is a hit and there is exactly one results row.
msha=$(shasum -a 256 deploy/seed/sample/baseline.idf | cut -d' ' -f1)
wsha=$(shasum -a 256 deploy/seed/sample/chicago.epw | cut -d' ' -f1)
echo "== QA-3 cache: model_sha=$msha (real sample bytes)"

# Expected content hash = sha256(model_sha ':' weather_sha ':' engine)
ch=$(printf '%s:%s:24.1.0' "$msha" "$wsha" | shasum -a 256 | cut -d' ' -f1)
echo "   expected content_hash=$ch"

echo "-- submit #1 (with sha, should run) --"
r1=$(submit_sim "24.1.0" "s3://models/sample/baseline.idf" "s3://weather/sample/chicago.epw" "$msha" "$wsha" 1)
echo "   $r1"
SIM1=$(echo "$r1" | sed -E 's/.*"id":"([^"]+)".*/\1/')

echo "   waiting for #1 to succeed..."
for _ in $(seq 1 30); do
  st=$(psql_t "SELECT state FROM app.simulations WHERE id='$SIM1'")
  [[ "$st" == succeeded || "$st" == failed ]] && break
  sleep 2
done
echo "   #1 final: $(psql_t "SELECT state||' attempts='||attempts FROM app.simulations WHERE id='$SIM1'")"

echo "-- submit #2 (SAME sha, should be IMMEDIATE cache hit) --"
r2=$(submit_sim "24.1.0" "s3://models/sample/baseline.idf" "s3://weather/sample/chicago.epw" "$msha" "$wsha" 1)
echo "   $r2  (expect state=succeeded directly)"
SIM2=$(echo "$r2" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "   #2 row: $(psql_t "SELECT state||' attempts='||attempts||' started='||COALESCE(started_at::text,'NULL') FROM app.simulations WHERE id='$SIM2'")"

echo "-- results rows for this content_hash (expect exactly 1) --"
psql_c "SELECT content_hash,verdict,(metrics->>'site_eui') AS site_eui,artifact_uri FROM app.results WHERE content_hash='$ch';"
echo "   count=$(psql_t "SELECT count(*) FROM app.results WHERE content_hash='$ch'")"

echo "-- submit #3 WITHOUT sha (must NOT cache-hit, runs with placeholder hash) --"
r3=$(submit_sim "24.1.0" "s3://models/sample/baseline.idf" "s3://weather/sample/chicago.epw" "" "" 1)
echo "   $r3  (expect state=queued, NOT succeeded)"
SIM3=$(echo "$r3" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "   #3 row: $(psql_t "SELECT state||' content_hash='||COALESCE(content_hash,'NULL') FROM app.simulations WHERE id='$SIM3'")"
