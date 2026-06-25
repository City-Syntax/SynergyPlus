#!/usr/bin/env bash
# QA-6: Cross-user idempotency key collision (M-3). The global UNIQUE on
# app.batches.idempotency_key + per-user lookup => user B reusing user A's key
# gets HTTP 500 instead of its own batch.
set -euo pipefail
cd "$(dirname "$0")/.."
source qa/lib.sh

echo "== ensure a 2nd user + key exist (qa2@nus.edu.sg / raw key 'qa2-key') =="
$COMPOSE exec -T postgres psql -U synergy -d synergy >/dev/null <<'SQL'
INSERT INTO app.users (email) VALUES ('qa2@nus.edu.sg') ON CONFLICT (email) DO NOTHING;
INSERT INTO app.api_keys (user_id, key_hash, name)
SELECT id, encode(digest('qa2-key','sha256'),'hex'), 'qa2'
FROM app.users WHERE email='qa2@nus.edu.sg'
ON CONFLICT (key_hash) DO NOTHING;
SQL

IK="shared-key-$(date +%s)"
body='{"engineVersion":"24.1.0","weather":{"ref":"s3://weather/sample/chicago.epw"},"idempotencyKey":"'"$IK"'","variants":[{"model":{"ref":"s3://models/sample/baseline.idf"}}]}'

echo "== user A (dev) submits key=$IK =="
curl -s -w " [%{http_code}]\n" -H "Authorization: Bearer synergy-dev-key" -X POST "$API/v1/batches" -d "$body"

echo "== user B (qa2-key) submits SAME key (expect own batch; BUG => 500) =="
curl -s -w " [%{http_code}]\n" -H "Authorization: Bearer qa2-key" -X POST "$API/v1/batches" -d "$body"
