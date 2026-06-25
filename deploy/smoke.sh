#!/usr/bin/env bash
# End-to-end smoke test against the running Compose stack.
# Submits a simulation with the seeded dev key, polls to completion, prints the result.
set -euo pipefail

API="${API:-http://localhost:8090}"
KEY="${KEY:-synergy-dev-key}"
MODEL_REF="${MODEL_REF:-s3://models/sample/baseline.idf}"
WEATHER_REF="${WEATHER_REF:-s3://weather/sample/chicago.epw}"
ENGINE="${ENGINE:-24.1.0}"

say() { printf "\033[36m[smoke]\033[0m %s\n" "$*"; }

say "health check $API/healthz"
curl -fsS "$API/healthz" >/dev/null && say "api healthy"

say "submitting simulation (engine $ENGINE)"
RESP=$(curl -fsS -X POST "$API/v1/simulations" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"engineVersion\":\"$ENGINE\",\"model\":{\"ref\":\"$MODEL_REF\"},\"weather\":{\"ref\":\"$WEATHER_REF\"},\"priority\":1}")
echo "$RESP"
SIM_ID=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
say "simulation id = $SIM_ID"

say "polling for completion..."
for i in $(seq 1 60); do
  S=$(curl -fsS "$API/v1/simulations/$SIM_ID" -H "Authorization: Bearer $KEY")
  STATE=$(printf '%s' "$S" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))")
  printf "  [%02d] state=%s\n" "$i" "$STATE"
  case "$STATE" in
    succeeded) say "SUCCESS"; echo "$S" | python3 -m json.tool; exit 0 ;;
    failed)    say "FAILED";  echo "$S" | python3 -m json.tool; exit 1 ;;
  esac
  sleep 2
done
say "timed out waiting for completion"; exit 1
