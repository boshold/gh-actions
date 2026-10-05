#!/usr/bin/env bash
# Asserts the seeded row and mail, then runs e2e.mjs against a fresh server.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is not set}"
token="fixture-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
cd "$(dirname "$0")/.."

count=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -v name="$token" \
  <<< "SELECT count(*) FROM fixture_items WHERE name = :'name';")
[[ "$count" == 1 ]] || { echo "::error::expected 1 seeded row '${token}', found ${count}"; exit 1; }

messages=$(curl --fail --silent --show-error --max-time 10 "${MAILPIT_URL:-http://127.0.0.1:8025}/api/v1/messages")
jq -e --arg s "$token" \
  '[.messages[] | select(.Subject == $s and any(.To[]; .Address == "seed@fixture.test"))] | length == 1' \
  <<< "$messages" >/dev/null || { echo "::error::seed mail '${token}' not in Mailpit"; jq . <<< "$messages"; exit 1; }
echo "seed row and mail found"

port="${E2E_PORT:-3200}"
revision="e2e-${token}"
PORT="$port" DEPLOYMENT_REVISION="$revision" node server.mjs &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl --silent --max-time 1 -o /dev/null "http://127.0.0.1:${port}/api/health" && break
  kill -0 "$server" 2>/dev/null || { echo "::error::server exited"; exit 1; }
  sleep 0.2
done
PORT="$port" EXPECTED_REVISION="$revision" node e2e.mjs
