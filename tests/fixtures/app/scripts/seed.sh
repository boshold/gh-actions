#!/usr/bin/env bash
# Inserts one row and sends one mail, both tagged with the run token.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is not set}"
token="fixture-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

# psql interpolates :'name' only in script input, not in -c
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -v name="$token" <<< "INSERT INTO fixture_items (name) VALUES (:'name');"

curl --fail --silent --show-error --max-time 10 "${SMTP_URL:-smtp://127.0.0.1:1025}" \
  --mail-from ci@fixture.test --mail-rcpt seed@fixture.test --upload-file - <<MAIL
From: ci@fixture.test
To: seed@fixture.test
Subject: ${token}

Seeded ${token}.
MAIL
echo "seeded ${token}"
