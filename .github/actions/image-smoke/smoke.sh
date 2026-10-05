#!/usr/bin/env bash
# Boots IMAGE, waits for a healthy {status, revision} answer, runs SMOKE_COMMAND.
set -euo pipefail

: "${PORT:=3000}"
: "${HEALTH_PATH:=/api/health}"
: "${HEALTH_STATUS:=ok}"
: "${TRIES:=45}"
: "${INTERVAL:=2}"
: "${GITHUB_OUTPUT:=/dev/null}"

[[ -n "${IMAGE:-}" ]] || { echo "::error::image is required"; exit 1; }
[[ -n "${REVISION:-}" ]] || { echo "::error::revision is required"; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "::error::port must be a number: ${PORT}"; exit 1; }
[[ "$TRIES" =~ ^[1-9][0-9]*$ ]] || { echo "::error::tries must be a positive number: ${TRIES}"; exit 1; }
[[ "$INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "::error::interval must be a number: ${INTERVAL}"; exit 1; }
[[ "$HEALTH_PATH" == /* ]] || HEALTH_PATH="/${HEALTH_PATH}"
command -v jq >/dev/null || { echo "::error::jq is required"; exit 1; }

suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-job}-$$-${RANDOM}"
container="image-smoke-$(printf '%s' "$suffix" | tr -c 'A-Za-z0-9_.-' '-' | tr '[:upper:]' '[:lower:]')"
env_file="$(mktemp)"
chmod 600 "$env_file"
ok=false

cleanup() {
  if [[ "$ok" != true ]] && docker container inspect "$container" >/dev/null 2>&1; then
    echo "::group::container logs"
    docker logs --tail 200 "$container" 2>&1 || true
    echo "::endgroup::"
  fi
  docker rm --force --volumes "$container" >/dev/null 2>&1 || true
  rm -f "$env_file"
}
trap cleanup EXIT

# add_env <input> <secret:true|false>
add_env() {
  local line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=(.*)$ ]]; then
      if [[ "$2" == true ]]; then echo "::error::invalid env-secrets line (expected KEY=VALUE)"; else echo "::error::invalid env line: ${line}"; fi
      exit 1
    fi
    value="${BASH_REMATCH[1]}"
    [[ "$2" == true && -n "$value" ]] && echo "::add-mask::${value}"
    printf '%s\n' "$line" >> "$env_file"
  done <<< "$1"
}
add_env "${ENV_INPUT:-}" false
add_env "${ENV_SECRETS:-}" true
if [[ "${INJECT_REVISION:-false}" == true ]] && ! grep -q '^DEPLOYMENT_REVISION=' "$env_file"; then
  printf 'DEPLOYMENT_REVISION=%s\n' "$REVISION" >> "$env_file"
fi

run_args=()
while IFS= read -r arg; do
  arg="${arg%$'\r'}"
  [[ -n "${arg//[[:space:]]/}" ]] && run_args+=("$arg")
done <<< "${RUN_ARGS:-}"
[[ -n "${MEMORY:-}" ]] && run_args+=(--memory "$MEMORY")

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
docker rm --force --volumes "$container" >/dev/null 2>&1 || true
docker run --detach --name "$container" --network host --env-file "$env_file" "${run_args[@]}" "$IMAGE" >/dev/null

url="http://127.0.0.1:${PORT}"
body=""
for (( attempt = 1; attempt <= TRIES; attempt++ )); do
  if body="$(curl --fail --silent --show-error --max-time 5 "${url}${HEALTH_PATH}" 2>/dev/null)"; then
    if ! jq -e 'type == "object"' >/dev/null 2>&1 <<< "$body"; then
      echo "::error::health answer is not a JSON object: ${body}"
      exit 1
    fi
    reported="$(jq -r '.revision // "" | tostring' <<< "$body")"
    if [[ "$reported" != "$REVISION" ]]; then
      echo "::error::health reports revision \"${reported}\", expected \"${REVISION}\": ${body}"
      exit 1
    fi
    if jq -e --arg s "$HEALTH_STATUS" '.status == $s' >/dev/null <<< "$body"; then
      echo "healthy: ${body}"
      break
    fi
    echo "status not ${HEALTH_STATUS} yet: ${body}"
  fi
  if [[ "$(docker container inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != true ]]; then
    echo "::error::the container stopped before it answered healthy"
    exit 1
  fi
  if (( attempt == TRIES )); then
    echo "::error::health never answered ${HEALTH_STATUS} with revision ${REVISION} after ${TRIES} tries"
    exit 1
  fi
  echo "waiting for health (attempt ${attempt}/${TRIES})"
  sleep "$INTERVAL"
done

{
  delimiter="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'body<<%s\n%s\n%s\n' "$delimiter" "$body" "$delimiter"
} >> "$GITHUB_OUTPUT"

if [[ -n "${SMOKE_COMMAND:-}" ]]; then
  echo "running smoke command"
  if ! SMOKE_URL="$url" SMOKE_CONTAINER="$container" bash -euo pipefail -c "$SMOKE_COMMAND"; then
    echo "::error::smoke command failed"
    exit 1
  fi
fi
ok=true
