#!/usr/bin/env bash
# shellcheck disable=SC2016 # SQL with literal $ quotes
# Scenario tests for .github/actions/prisma-check. Run: tests/prisma-check/run.sh <sqlite|postgresql>
# Needs `pnpm install` in tests/prisma-check/fixture and jq. postgresql needs a server at PG_URL;
# with PG_CONTAINER set, databases are created via docker exec, else migrate deploy creates them.
set -euo pipefail

PROVIDER="${1:?usage: run.sh <sqlite|postgresql>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURE="$HERE/fixture"
CHECK="$ROOT/.github/actions/prisma-check/check.sh"
PRISMA="$FIXTURE/node_modules/.bin/prisma"
: "${PG_CONTAINER:=}"
: "${PG_URL:=postgresql://postgres:postgres@127.0.0.1:5432}"

[[ -x "$PRISMA" ]] || { echo "run pnpm install in $FIXTURE first"; exit 1; }
case "$PROVIDER" in sqlite|postgresql) ;; *) echo "unknown provider: $PROVIDER"; exit 1 ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SCHEMA="prisma/$PROVIDER/schema.prisma"
MIGRATIONS="prisma/$PROVIDER/migrations"
git_() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"; }

pass=0; failed=0; n=0; repos=0

new_database() { # sets URL; not via $(...) so the counter survives
  n=$((n + 1))
  if [[ "$PROVIDER" == sqlite ]]; then
    URL="file:$TMP/case$n.db"
  else
    [[ -n "$PG_CONTAINER" ]] && docker exec "$PG_CONTAINER" createdb -h 127.0.0.1 -U postgres "case$n" >/dev/null
    URL="$PG_URL/case$n"
  fi
}

# Fresh repo per case: fixture committed on main, pushed to a local origin, checked out on "pr".
# setup [subdir]: the fixture lives in <subdir> of the repo (like a monorepo app), REPO points there.
setup() {
  repos=$((repos + 1))
  GIT_ROOT="$TMP/repo$repos"
  REPO="$GIT_ROOT${1:+/$1}"
  mkdir -p "$REPO"
  tar -C "$FIXTURE" --exclude=node_modules -cf - . | tar -C "$REPO" -xf -
  git_ -C "$GIT_ROOT" init -q -b main
  git_ -C "$GIT_ROOT" add -A
  git_ -C "$GIT_ROOT" commit -qm base
  git_ clone -q --bare "$GIT_ROOT" "$GIT_ROOT.origin"
  git_ -C "$GIT_ROOT.origin" config uploadpack.allowReachableSHA1InWant true
  git_ -C "$GIT_ROOT" remote add origin "file://$GIT_ROOT.origin"
  git_ -C "$GIT_ROOT" checkout -q -b pr
  ln -s "$FIXTURE/node_modules" "$REPO/node_modules"
}

commit() { git_ -C "$GIT_ROOT" add -A && git_ -C "$GIT_ROOT" commit -qm change; }

# add_migration <name> <sql file content>
add_migration() {
  mkdir -p "$REPO/$MIGRATIONS/$1"
  printf '%s\n' "$2" > "$REPO/$MIGRATIONS/$1/migration.sql"
}

# diff_sql <new schema content>: SQL from the current schema to the given one, schema file updated
diff_sql() {
  printf '%s\n' "$1" > "$TMP/next.prisma"
  (cd "$REPO" && "$PRISMA" migrate diff --from-schema "$SCHEMA" --to-schema "$TMP/next.prisma" --script 2>/dev/null)
  cp "$TMP/next.prisma" "$REPO/$SCHEMA"
}

indent() { local line; while IFS= read -r line; do echo "       $line"; done <<< "$1"; }

# expect <name> <exit> <pattern|""> [VAR=value ...]
expect() {
  local name="$1" want="$2" pattern="$3" out status=0
  shift 3
  new_database
  out="$(cd "$REPO" && env LEVEL=standard SCHEMA="$SCHEMA" MIGRATIONS="$MIGRATIONS" PRISMA_COMMAND="$PRISMA" \
    BASE_REF=main DATABASE_URL="$URL" GITHUB_STEP_SUMMARY=/dev/null GITHUB_OUTPUT=/dev/null \
    GITHUB_EVENT_NAME=pull_request PR_LABELS='[]' "$@" bash "$CHECK" 2>&1)" || status=$?
  if [[ "$status" != "$want" ]]; then
    failed=$((failed + 1)); echo "  FAIL $name: exit $status, expected $want"; indent "$out"
  elif [[ -n "$pattern" ]] && ! grep -qE -- "$pattern" <<< "$out"; then
    failed=$((failed + 1)); echo "  FAIL $name: output lacks /$pattern/"; indent "$out"
  else
    pass=$((pass + 1)); echo "  ok   $name"
  fi
}

base_schema="$(cat "$FIXTURE/$SCHEMA")"
with_nick="${base_schema/  name  String?/  name  String?
  nick  String?}"
without_name="${base_schema/  name  String?
/}"
with_default="${base_schema/  email String  @unique/  email String  @unique @default(\"\")}"
other_provider=postgresql; [[ "$PROVIDER" == postgresql ]] && other_provider=sqlite

echo "prisma-check ($PROVIDER)"

setup
expect "clean passes" 0 '\| schema drift \| ok \|'
expect "clean passes at strict with BEGIN/COMMIT (no new migrations)" 0 '\| BEGIN/COMMIT \| ok \|' LEVEL=strict REQUIRE_TRANSACTION=true
expect "no base ref skips base checks" 0 'skipped \(no base\)' BASE_REF=
expect "zero sha (new branch) skips base checks" 0 'skipped \(no base\)' BASE_REF=0000000000000000000000000000000000000000
expect "invalid level" 1 'invalid level' LEVEL=paranoid

setup
printf '%s\n' "$with_nick" > "$REPO/$SCHEMA"; commit
expect "schema change without migration is drift" 1 '\| schema drift \| fail \|'
expect "drift prints the missing SQL" 1 'ADD COLUMN.*"nick"'

setup
sql="$(diff_sql "$with_nick")"
add_migration 20260201000000_add_nick "$sql"; commit
expect "schema change with migration passes" 0 '\| schema drift \| ok \|'
expect "new migration without BEGIN/COMMIT fails when required" 1 'wrapped in BEGIN' REQUIRE_TRANSACTION=true

setup
sql="$(diff_sql "$with_nick")"
add_migration 20260201000000_add_nick "BEGIN;
$sql
COMMIT;"; commit
expect "new migration wrapped in BEGIN/COMMIT passes when required" 0 '\| BEGIN/COMMIT \| ok \|' REQUIRE_TRANSACTION=true

setup
add_migration 20260201000000_add_nick "BEGIN;
COMMIT;
$sql"; commit
expect "statements after COMMIT fail when required" 1 'wrapped in BEGIN' REQUIRE_TRANSACTION=true

setup
base_sha="$(git_ -C "$GIT_ROOT" rev-parse main)"
git_ -C "$GIT_ROOT" checkout -q main
sql="$(diff_sql "$with_nick")"
add_migration 20260201000000_add_nick "$sql"; commit
git_ -C "$GIT_ROOT" push -q origin main
git_ -C "$GIT_ROOT" checkout -q pr
expect "base branch moved on: branch tip reports a deletion" 1 'migration deleted after merge'
expect "base branch moved on: base SHA passes" 0 '\| merged migrations unchanged \| ok \|' BASE_REF="$base_sha"

setup
echo "-- edited" >> "$REPO/$MIGRATIONS/20260101000000_init/migration.sql"; commit
expect "edited merged migration fails at standard" 1 'migration changed after merge'
expect "edited merged migration passes at basic" 0 '' LEVEL=basic

setup
rm -r "$REPO/$MIGRATIONS/20260102000000_add_name"
printf '%s\n' "$without_name" > "$REPO/$SCHEMA"; commit
expect "deleted merged migration fails" 1 'migration deleted after merge'

setup
sql="$(diff_sql "$without_name")"
if [[ "$PROVIDER" == sqlite ]]; then
  # SQLite drops columns via table rebuild; only migrate dev's warning block reveals the data loss
  sql="/*
  Warnings:

  - You are about to drop the column \`name\` on the \`user\` table. All the data in the column will be lost.

*/
$sql"
fi
add_migration 20260201000000_drop_name "$sql"; commit
expect "destructive migration warns at standard" 0 '::warning .*destructive migration'
expect "destructive migration fails at strict" 1 '::error .*destructive migration' LEVEL=strict
expect "destructive migration passes at strict with label" 0 'allowed \(label' LEVEL=strict 'PR_LABELS=["migration:destructive","other"]'
expect "destructive migration only warns at strict on push" 0 '\| destructive SQL \| warning \(not a PR\) \|' LEVEL=strict GITHUB_EVENT_NAME=push
expect "label at standard still reports a warning" 0 '\| destructive SQL \| warning \|' 'PR_LABELS=["migration:destructive"]'

setup
add_migration 20260201000000_drop_user 'DROP TABLE "user";
CREATE TABLE "new_userTag" ("id" TEXT NOT NULL PRIMARY KEY);
DROP TABLE "userTag";
ALTER TABLE "new_userTag" RENAME TO "userTag";'; commit
expect "DROP TABLE next to a rebuild of a longer table name fails at strict" 1 'DROP TABLE user[^T]' LEVEL=strict

setup
sql="$(diff_sql "$with_default")"
add_migration 20260201000000_email_default "$sql"; commit
expect "non-destructive change (SQLite rebuild) passes at strict" 0 '\| destructive SQL \| ok \|' LEVEL=strict

setup apps/web
sql="$(diff_sql "$without_name")"
[[ "$PROVIDER" == sqlite ]] && sql="-- ALTER TABLE \"user\" DROP COLUMN \"name\" (rebuild below)
ALTER TABLE \"user\" DROP COLUMN \"name\";"
add_migration 20260201000000_drop_name "$sql"
echo "-- edited" >> "$REPO/$MIGRATIONS/20260101000000_init/migration.sql"; commit
expect "subdirectory: edited migration found" 1 "file=$MIGRATIONS/20260101000000_init/migration.sql::migration changed"
expect "subdirectory: new migration linted" 1 "file=$MIGRATIONS/20260201000000_drop_name/migration.sql::destructive"

setup
sed -i "s/provider = \"$PROVIDER\"/provider = \"$other_provider\"/" "$REPO/$MIGRATIONS/migration_lock.toml"; commit
expect "migration_lock.toml provider mismatch fails" 1 'does not match schema provider'

setup
rm "$REPO/$MIGRATIONS/migration_lock.toml"; commit
expect "missing migration_lock.toml fails with a message" 1 'missing or unreadable migration_lock.toml'

# --- base resolution and SQL edge cases ---------------------------------------
setup
expect "strict: no base on a pull request fails closed" 1 'no base ref on a pull request' LEVEL=strict BASE_REF=
expect "strict: no base on push skips" 0 'skipped \(no base\)' LEVEL=strict BASE_REF= GITHUB_EVENT_NAME=push
expect "strict: unfetchable base fails closed" 1 'could not fetch base' LEVEL=strict BASE_REF=refs/heads/does-not-exist
expect "strict: fail-on-unknown-base=false skips" 0 'skipped \(no base\)' LEVEL=strict BASE_REF= FAIL_ON_UNKNOWN_BASE=false
expect "standard: unfetchable base warns" 0 '::warning::could not fetch base' BASE_REF=refs/heads/does-not-exist
expect "standard: fail-on-unknown-base=true fails" 1 'no base ref on a pull request' BASE_REF= FAIL_ON_UNKNOWN_BASE=true

setup
add_migration 20260201000000_drop_qualified 'DROP TABLE IF EXISTS "public"."user";'; commit
expect "schema-qualified DROP TABLE fails at strict" 1 'DROP TABLE user' LEVEL=strict

setup
add_migration 20260201000000_string_dashes 'INSERT INTO "user" ("id", "email") VALUES ('"'a--b'"', '"'x'"'); ALTER TABLE "user" DROP COLUMN "name";'; commit
expect "-- inside a string does not hide SQL" 1 'destructive migration: DROP COLUMN' LEVEL=strict

setup
add_migration 20260201000000_string_prose "-- DROP TABLE \"user\"; in a comment
/* DELETE FROM \"user\"; */
INSERT INTO \"user\" (\"id\", \"email\") VALUES ('1', 'DROP TABLE x; DELETE FROM y');"; commit
expect "destructive words in comments and strings pass at strict" 0 '\| destructive SQL \| ok \|' LEVEL=strict GITHUB_STEP_SUMMARY="$TMP/summary.md"
if grep -q 'New migration <code>prisma/'"$PROVIDER"'/migrations/20260201000000_string_prose/migration.sql</code>' "$TMP/summary.md" \
  && grep -q "VALUES ('1', 'DROP TABLE x; DELETE FROM y')" "$TMP/summary.md"; then
  pass=$((pass + 1)); echo "  ok   job summary lists the new migration SQL"
else
  failed=$((failed + 1)); echo "  FAIL job summary lists the new migration SQL"; indent "$(cat "$TMP/summary.md")"
fi

setup
add_migration 20260201000000_reindex 'DROP INDEX "user_email_key";
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");'; commit
expect "DROP INDEX recreated under the same name passes at strict" 0 '\| destructive SQL \| ok \|' LEVEL=strict

setup
add_migration 20260201000000_drop_index 'DROP INDEX "user_email_key";'; commit
expect "DROP INDEX fails at strict" 1 'DROP INDEX user_email_key' LEVEL=strict

setup
add_migration 20260201000000_drop_constraint 'ALTER TABLE "user" DROP CONSTRAINT "user_pkey";'; commit
expect "DROP CONSTRAINT fails at strict" 1 'DROP CONSTRAINT user_pkey' LEVEL=strict

setup
add_migration 20260201000000_readd_constraint 'ALTER TABLE "user" DROP CONSTRAINT "user_fkey";
ALTER TABLE "user" ADD CONSTRAINT "user_fkey" FOREIGN KEY ("id") REFERENCES "user"("id");'; commit
expect "DROP CONSTRAINT re-added under the same name is not destructive" 0 '\| destructive SQL \| ok \|' LEVEL=strict PRISMA_COMMAND=true

setup
add_migration 20260201000000_misc 'DELETE FROM "user";
ALTER TABLE "user" RENAME COLUMN "name" TO "nick";
DROP TYPE "Role";
DROP SCHEMA "legacy";
ALTER TABLE "public"."user" RENAME TO "people";'; commit
expect "DELETE FROM, RENAME COLUMN, DROP SCHEMA, DROP TYPE, table rename are destructive" 1 \
  'destructive migration: DELETE FROM,RENAME COLUMN,DROP SCHEMA,DROP TYPE,RENAME TABLE user' LEVEL=strict

setup
add_migration 20260201000000_multiline 'DELETE
FROM "user";
DROP
  TABLE "post";'; commit
expect "statements split across lines are scanned" 1 'destructive migration: DELETE FROM,DROP TABLE post' LEVEL=strict PRISMA_COMMAND=true

setup
add_migration 20260201000000_do_block 'DO $$ BEGIN TRUNCATE "user"; END $$;'; commit
expect "DO block body is scanned at strict" 1 'destructive migration: TRUNCATE' LEVEL=strict
expect "DO block passes at strict with label" 0 'allowed \(label' LEVEL=strict 'PR_LABELS=["migration:destructive"]' PRISMA_COMMAND=true

setup
add_migration 20260201000000_do_tagged 'do language plpgsql
$body$
BEGIN
  DELETE FROM "user" WHERE "email" = '"'x'"';
END
$body$;'; commit
expect "tagged DO block with LANGUAGE is scanned" 1 'destructive migration: DELETE FROM' LEVEL=strict PRISMA_COMMAND=true

setup
add_migration 20260201000000_function 'CREATE FUNCTION "wipe"() RETURNS trigger AS $fn$ BEGIN TRUNCATE "user"; RETURN $$x$$; END $fn$ LANGUAGE plpgsql;'; commit
expect "function bodies stay stripped" 0 '\| destructive SQL \| ok \|' LEVEL=strict PRISMA_COMMAND=true

if [[ "$PROVIDER" == sqlite ]]; then
  rebuild() { # rebuild <select list> [where] [insert column list, default: select list]
    printf '%s\n' 'PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT DEFAULT '"'anon'"'
);
INSERT INTO "new_user" ('"${3:-$1}"') SELECT '"$1"' FROM "user"'"${2:-}"';
DROP TABLE "user";
ALTER TABLE "new_user" RENAME TO "user";
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;'
  }
  with_name_default="${base_schema/  name  String?/  name  String? @default(\"anon\")}"

  setup
  add_migration 20260201000000_rebuild "$(rebuild '"email", "id", "name"')"
  printf '%s\n' "$with_name_default" > "$REPO/$SCHEMA"; commit
  expect "lossless SQLite rebuild passes at strict" 0 '\| destructive SQL \| ok \|' LEVEL=strict

  setup
  add_migration 20260201000000_rebuild "$(rebuild '"id", "email"')"
  printf '%s\n' "$with_name_default" > "$REPO/$SCHEMA"; commit
  expect "lossy SQLite rebuild fails at strict" 1 'DROP TABLE user \(rebuild loses columns or unverifiable\)' LEVEL=strict

  setup
  add_migration 20260201000000_rebuild "$(rebuild '"email", "id", "name"' ' WHERE "name" IS NOT NULL')"
  printf '%s\n' "$with_name_default" > "$REPO/$SCHEMA"; commit
  expect "filtered SQLite rebuild fails at strict" 1 'DROP TABLE user \(rebuild loses' LEVEL=strict

  setup
  add_migration 20260201000000_rebuild "$(rebuild '"id", "name", "email"' '' '"id", "email", "name"')"
  printf '%s\n' "$with_name_default" > "$REPO/$SCHEMA"; commit
  expect "SQLite rebuild that swaps columns fails at strict" 1 'DROP TABLE user \(rebuild loses' LEVEL=strict
fi

echo
echo "passed: $pass  failed: $failed"
(( failed == 0 ))
