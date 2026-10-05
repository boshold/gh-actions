#!/usr/bin/env bash
# Creates the fixture table and proves the extra database exists.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is not set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE TABLE fixture_items (id serial PRIMARY KEY, name text NOT NULL UNIQUE)'

second_url="${DATABASE_URL%/*}/second"
current=$(psql "$second_url" -v ON_ERROR_STOP=1 -tAc 'SELECT current_database()')
[[ "$current" == second ]] || { echo "::error::expected database second, got '${current}'"; exit 1; }
echo "migrated; database second reachable"
