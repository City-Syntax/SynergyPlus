#!/usr/bin/env bash
# Shared helpers for SynergyPlus QA scripts.
set -euo pipefail

API="${API:-http://localhost:8090}"
KEY="${KEY:-synergy-dev-key}"
COMPOSE="docker compose -f deploy/docker-compose.yml"

# Run psql against the compose Postgres, returning tuples-only output.
psql_t() {
  $COMPOSE exec -T postgres psql -U synergy -d synergy -At -c "$1"
}

psql_c() {
  $COMPOSE exec -T postgres psql -U synergy -d synergy -c "$1"
}

# POST a single simulation. Args: engineVersion model_ref weather_ref [model_sha] [weather_sha] [priority]
submit_sim() {
  local ev="$1" mref="$2" wref="$3" msha="${4:-}" wsha="${5:-}" prio="${6:-1}"
  local model='{"ref":"'"$mref"'"'
  [ -n "$msha" ] && model="$model"',"sha256":"'"$msha"'"'
  model="$model"'}'
  local weather='{"ref":"'"$wref"'"'
  [ -n "$wsha" ] && weather="$weather"',"sha256":"'"$wsha"'"'
  weather="$weather"'}'
  curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -X POST "$API/v1/simulations" \
    -d '{"engineVersion":"'"$ev"'","priority":'"$prio"',"model":'"$model"',"weather":'"$weather"'}'
}
