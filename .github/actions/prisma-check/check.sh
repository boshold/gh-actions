#!/usr/bin/env bash
# Prisma migration checks. See action.yml for inputs; levels: basic < standard < strict.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${LEVEL:=standard}"
: "${SCHEMA:=prisma/schema.prisma}"
: "${MIGRATIONS:=prisma/migrations}"
: "${PRISMA_COMMAND:=pnpm exec prisma}"
: "${BASE_REF:=}"
: "${ALLOW_DESTRUCTIVE_LABEL:=migration:destructive}"
: "${PR_LABELS:=[]}"
: "${REQUIRE_TRANSACTION:=false}"
: "${FAIL_ON_UNKNOWN_BASE:=}"
: "${GITHUB_STEP_SUMMARY:=/dev/null}"
: "${GITHUB_OUTPUT:=/dev/null}"
: "${GITHUB_EVENT_NAME:=}"

case "$LEVEL" in
  basic|standard|strict) ;;
  *) echo "::error::invalid level: ${LEVEL} (basic, standard, strict)"; exit 1 ;;
esac
[[ -n "${DATABASE_URL:-}" ]] || { echo "::error::database-url is required"; exit 1; }
[[ -e "$SCHEMA" ]] || { echo "::error::schema not found: ${SCHEMA}"; exit 1; }
[[ -d "$MIGRATIONS" ]] || { echo "::error::migrations directory not found: ${MIGRATIONS}"; exit 1; }
command -v jq >/dev/null || { echo "::error::jq is required"; exit 1; }
export DATABASE_URL

read -r -a prisma <<< "$PRISMA_COMMAND"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failed=0
drift_found=false
rows=()
record() { # record <check> <result>
  rows+=("| $1 | $2 |")
  [[ "$2" == "fail"* ]] && failed=1
  return 0
}

at_least() { # at_least <level>
  local order=(basic standard strict) i want=0 have=0
  for i in "${!order[@]}"; do
    [[ "${order[$i]}" == "$1" ]] && want=$i
    [[ "${order[$i]}" == "$LEVEL" ]] && have=$i
  done
  (( have >= want ))
}

strip_sql() { awk -f "$HERE/strip-sql.awk" "$1"; }

# Only PRs carry labels; on push the PR run already enforced the gates
is_pr=true
[[ -z "$GITHUB_EVENT_NAME" || "$GITHUB_EVENT_NAME" == pull_request* ]] || is_pr=false

fail_unknown="$FAIL_ON_UNKNOWN_BASE"
if [[ -z "$fail_unknown" ]]; then
  if at_least strict; then fail_unknown=true; else fail_unknown=false; fi
fi

# Checkouts without persisted credentials (private repos) need the token for the base fetch.
git_auth() {
  if [[ -n "${FETCH_TOKEN:-}" ]]; then
    local header
    header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$FETCH_TOKEN" | base64 -w0)"
    git -c "http.https://github.com/.extraheader=${header}" "$@"
  else
    git "$@"
  fi
}

# --- Base resolution: which migrations are new in this change? ---------------
base=""
base_problem=""
if [[ -z "$BASE_REF" || "$BASE_REF" =~ ^0+$ ]]; then
  # No base on push (new branch, other branch) is by design: the PR run covers it
  [[ "$is_pr" == true && -n "$GITHUB_EVENT_NAME" ]] && base_problem="no base ref on a pull request"
  [[ -z "$base_problem" ]] && echo "::notice::no base ref (new branch or manual run); skipping checks that compare against the base"
elif base="$(git rev-parse --verify --quiet "${BASE_REF}^{commit}" 2>/dev/null)"; then
  :
elif git_auth fetch --quiet --no-tags --depth=1 origin "$BASE_REF" 2>"$work/fetch.log"; then
  base="$(git rev-parse FETCH_HEAD)"
else
  base=""
  base_problem="could not fetch base ${BASE_REF}"
  cat "$work/fetch.log"
fi
if [[ -n "$base_problem" ]]; then
  if [[ "$fail_unknown" == true ]]; then
    echo "::error::${base_problem}; the base checks cannot run (fail-on-unknown-base)"
    record "base" "fail (${base_problem})"
  else
    echo "::warning::${base_problem}; skipping checks that compare against the base"
  fi
fi

new_migrations=()
if [[ -n "$base" ]]; then
  git diff --relative --name-status --no-renames "$base" HEAD -- "$MIGRATIONS" > "$work/changes"
  while IFS=$'\t' read -r status path; do
    [[ "$path" == */migration.sql ]] || continue
    case "$status" in
      A) new_migrations+=("$path") ;;
      M|D) echo "$status $path" >> "$work/rewritten" ;;
    esac
  done < "$work/changes"
fi
mapfile -t all_migrations < <(find "$MIGRATIONS" -mindepth 2 -maxdepth 2 -name migration.sql | sort)

# Identifier, optionally schema-qualified: "public"."user" | public.user | "user" | user
ident='"?[A-Za-z0-9_]+"?'
qualified="(${ident}[.])?${ident}"
last_name() { sed -E 's/.*[[:space:].]"?([A-Za-z0-9_]+)"?$/\1/'; }

# destructive_reasons <file>: prints one reason per line
destructive_reasons() {
  local file="$1" sql name
  # Prisma's own warning block (migrate dev), the only signal for SQLite table rebuilds
  # shellcheck disable=SC2016 # literal backticks
  grep -qE '^[[:space:]]*-[[:space:]]+(You are about to|The required column|Added the required column|A unique constraint|The values|Changed the type|Made the column|The `[^`]+` column on the `[^`]+` table would be dropped)' "$file" \
    && echo "Prisma data-loss warning"
  sql="$(strip_sql "$file")"
  grep -qiE 'DROP[[:space:]]+COLUMN' <<< "$sql" && echo "DROP COLUMN"
  grep -qiE 'ALTER[[:space:]]+COLUMN[^;]*[[:space:]]TYPE[[:space:]]' <<< "$sql" && echo "ALTER COLUMN TYPE"
  grep -qiE '(^|[[:space:];])TRUNCATE[[:space:]]' <<< "$sql" && echo "TRUNCATE"
  grep -qiE '(^|[[:space:];])DELETE[[:space:]]+FROM[[:space:]]' <<< "$sql" && echo "DELETE FROM"
  grep -qiE 'RENAME[[:space:]]+COLUMN' <<< "$sql" && echo "RENAME COLUMN"
  grep -qiE 'DROP[[:space:]]+SCHEMA' <<< "$sql" && echo "DROP SCHEMA"
  grep -qiE 'DROP[[:space:]]+TYPE' <<< "$sql" && echo "DROP TYPE"
  # DROP TABLE, except SQLite rebuilds (RENAME "new_x" TO "x") that provably copy every column
  local rebuilt="" rebuilt_done=false
  while read -r name; do
    [[ -n "$name" ]] || continue
    if ! grep -qiE "\"?new_${name}\"?[[:space:]]+RENAME[[:space:]]+TO[[:space:]]+(${ident}[.])?\"?${name}\"?([^A-Za-z0-9_]|$)" <<< "$sql"; then
      echo "DROP TABLE ${name}"
      continue
    fi
    if [[ "$rebuilt_done" == false ]]; then
      rebuilt="$(node --no-warnings "$HERE/sqlite-columns.mjs" "$file" "${all_migrations[@]}" || true)"
      rebuilt_done=true
    fi
    grep -qixF -- "$name" <<< "$rebuilt" || echo "DROP TABLE ${name} (rebuild loses columns or unverifiable)"
  done < <(grep -oiE "DROP[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?${qualified}" <<< "$sql" | last_name)
  # Table rename, except the SQLite rebuild's "new_x" -> "x"
  while read -r from to; do
    [[ -n "$from" && "$from" != "new_${to}" ]] && echo "RENAME TABLE ${from}"
  done < <(grep -oiE "ALTER[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?${qualified}[[:space:]]+RENAME[[:space:]]+TO[[:space:]]+${qualified}" <<< "$sql" \
    | sed -E "s/^ALTER[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?(${ident}[.])?\"?([A-Za-z0-9_]+)\"?[[:space:]]+RENAME[[:space:]]+TO[[:space:]]+(${ident}[.])?\"?([A-Za-z0-9_]+)\"?$/\3 \5/I")
  # DROP INDEX / DROP CONSTRAINT, unless recreated under the same name in this migration
  while read -r name; do
    [[ -n "$name" ]] || continue
    grep -qiE "CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[[:space:]]+(CONCURRENTLY[[:space:]]+)?(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?(${ident}[.])?\"?${name}\"?([^A-Za-z0-9_]|$)" <<< "$sql" \
      || echo "DROP INDEX ${name}"
  done < <(grep -oiE "DROP[[:space:]]+INDEX[[:space:]]+(CONCURRENTLY[[:space:]]+)?(IF[[:space:]]+EXISTS[[:space:]]+)?${qualified}" <<< "$sql" | last_name)
  while read -r name; do
    [[ -n "$name" ]] || continue
    grep -qiE "ADD[[:space:]]+CONSTRAINT[[:space:]]+\"?${name}\"?([^A-Za-z0-9_]|$)" <<< "$sql" \
      || echo "DROP CONSTRAINT ${name}"
  done < <(grep -oiE "DROP[[:space:]]+CONSTRAINT[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?${ident}" <<< "$sql" | last_name)
  return 0
}

# --- Static checks (fail fast, clear messages) -------------------------------
if at_least standard; then
  if [[ -z "$base" ]]; then
    record "merged migrations unchanged" "skipped (no base)"
  elif [[ -s "$work/rewritten" ]]; then
    while read -r status path; do
      verb="changed"; [[ "$status" == D ]] && verb="deleted"
      echo "::error file=${path}::migration ${verb} after merge; add a new migration instead (Prisma checksums break deploys)"
    done < "$work/rewritten"
    record "merged migrations unchanged" "fail"
  else
    record "merged migrations unchanged" "ok"
  fi

  lock="$MIGRATIONS/migration_lock.toml"
  schema_files=("$SCHEMA")
  [[ -d "$SCHEMA" ]] && mapfile -t schema_files < <(find "$SCHEMA" -name '*.prisma' | sort)
  (( ${#schema_files[@]} )) || { echo "::error::no .prisma files in schema: ${SCHEMA}"; exit 1; }
  schema_provider="$(awk '/^[[:space:]]*datasource[[:space:]]/ { inside = 1 } inside && /provider[[:space:]]*=/ { gsub(/.*=[[:space:]]*"|".*/, ""); print; exit }' "${schema_files[@]}")"
  lock_provider=""
  if [[ -f "$lock" ]]; then
    lock_provider="$(sed -n 's/^[[:space:]]*provider[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$lock" | head -n 1)"
  fi
  if [[ -z "$lock_provider" ]]; then
    echo "::error file=${lock}::missing or unreadable migration_lock.toml"
    record "migration_lock.toml provider" "fail"
  elif [[ "$lock_provider" != "$schema_provider" ]]; then
    echo "::error file=${lock}::provider \"${lock_provider}\" does not match schema provider \"${schema_provider}\""
    record "migration_lock.toml provider" "fail"
  else
    record "migration_lock.toml provider" "ok (${lock_provider})"
  fi

  label_allowed=false
  jq -e --arg l "$ALLOW_DESTRUCTIVE_LABEL" 'index($l) != null' <<< "$PR_LABELS" >/dev/null 2>&1 && label_allowed=true
  enforce_destructive=false
  at_least strict && [[ "$is_pr" == true && "$label_allowed" == false ]] && enforce_destructive=true
  destructive=0
  for file in "${new_migrations[@]}"; do
    mapfile -t reasons < <(destructive_reasons "$file")
    (( ${#reasons[@]} )) || continue
    destructive=1
    message="destructive migration: $(IFS=,; echo "${reasons[*]}")"
    if [[ "$enforce_destructive" == true ]]; then
      echo "::error file=${file}::${message}. Add the PR label \"${ALLOW_DESTRUCTIVE_LABEL}\" if intended (the workflow must trigger on labeled)"
    else
      echo "::warning file=${file}::${message}"
    fi
  done
  if [[ -z "$base" ]]; then
    record "destructive SQL" "skipped (no base)"
  elif (( destructive == 0 )); then
    record "destructive SQL" "ok"
  elif [[ "$enforce_destructive" == true ]]; then
    record "destructive SQL" "fail"
  elif at_least strict && [[ "$is_pr" == false ]]; then
    record "destructive SQL" "warning (not a PR)"
  elif at_least strict; then
    record "destructive SQL" "allowed (label ${ALLOW_DESTRUCTIVE_LABEL})"
  else
    record "destructive SQL" "warning"
  fi
fi

if [[ "$REQUIRE_TRANSACTION" == true ]]; then
  tx_failed=0
  for file in "${new_migrations[@]}"; do
    sql="$(strip_sql "$file" | awk NF)"
    if ! head -n 1 <<< "$sql" | grep -qiE '^[[:space:]]*BEGIN[[:space:]]*;[[:space:]]*$' \
      || ! tail -n 1 <<< "$sql" | grep -qiE '^[[:space:]]*COMMIT[[:space:]]*;[[:space:]]*$'; then
      echo "::error file=${file}::migration must be wrapped in BEGIN; ... COMMIT;"
      tx_failed=1
    fi
  done
  if [[ -z "$base" ]]; then record "BEGIN/COMMIT" "skipped (no base)"
  elif (( tx_failed )); then record "BEGIN/COMMIT" "fail"
  else record "BEGIN/COMMIT" "ok"; fi
fi

# --- Database checks ---------------------------------------------------------
if (( failed )); then
  record "migrate deploy" "skipped (earlier failure)"
  record "schema drift" "skipped (earlier failure)"
  echo "drift=" >> "$GITHUB_OUTPUT"
else
  if "${prisma[@]}" migrate deploy; then
    record "migrate deploy" "ok"
    status=0
    "${prisma[@]}" migrate diff --from-config-datasource --to-schema "$SCHEMA" --exit-code --script > "$work/drift.sql" || status=$?
    case "$status" in
      0) record "schema drift" "ok"; echo "drift=false" >> "$GITHUB_OUTPUT" ;;
      2)
        echo "::error file=${SCHEMA}::schema drift: the schema has changes no migration covers. Missing SQL:"
        cat "$work/drift.sql"
        record "schema drift" "fail"
        drift_found=true
        echo "drift=true" >> "$GITHUB_OUTPUT"
        ;;
      *) record "schema drift" "fail (migrate diff exited ${status})"; echo "drift=" >> "$GITHUB_OUTPUT" ;;
    esac
  else
    echo "::error::prisma migrate deploy failed on an empty database"
    record "migrate deploy" "fail"
    record "schema drift" "skipped (deploy failed)"
    echo "drift=" >> "$GITHUB_OUTPUT"
  fi
fi

{
  echo "### Prisma check (${LEVEL})"
  echo
  echo "| Check | Result |"
  echo "| --- | --- |"
  printf '%s\n' "${rows[@]}"
  if [[ "$drift_found" == true ]]; then
    printf '\n<details open><summary>Missing migration SQL</summary>\n\n```sql\n'
    cat "$work/drift.sql"
    printf '```\n</details>\n'
  fi
  for file in "${new_migrations[@]}"; do
    lines="$(wc -l < "$file")"
    printf '\n<details><summary>New migration <code>%s</code> (%s lines)</summary>\n\n```sql\n' "$file" "$lines"
    head -n 200 "$file"
    (( lines > 200 )) && printf -- '-- … %s more lines\n' "$((lines - 200))"
    printf '```\n</details>\n'
  done
} >> "$GITHUB_STEP_SUMMARY"
printf '%s\n' "${rows[@]}"

exit "$failed"
