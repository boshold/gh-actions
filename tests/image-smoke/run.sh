#!/usr/bin/env bash
# shellcheck disable=SC2016 # smoke commands expand inside the action
# Scenario tests for .github/actions/image-smoke. Run: tests/image-smoke/run.sh (needs docker, curl, jq; Linux host network).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SMOKE="$ROOT/.github/actions/image-smoke/smoke.sh"
TAG="image-smoke-fixture:$$"
REV="rev-$$-${RANDOM}"
PORT="$((30000 + RANDOM % 20000))"

trap 'docker rmi --force "$TAG" "$TAG-norev" >/dev/null 2>&1 || true' EXIT
docker build --quiet --build-arg "DEPLOYMENT_REVISION=$REV" -t "$TAG" "$HERE/fixture" >/dev/null
docker build --quiet -t "$TAG-norev" "$HERE/fixture" >/dev/null

pass=0; failed=0
indent() { local line; while IFS= read -r line; do echo "       $line"; done <<< "$1"; }

# expect <name> <exit> <pattern|""> [VAR=value ...]
expect() {
  local name="$1" want="$2" pattern="$3" out status=0
  shift 3
  out="$(env IMAGE="$TAG" REVISION="$REV" PORT="$PORT" ENV_INPUT="PORT=$PORT" TRIES=10 INTERVAL=0.5 \
    GITHUB_OUTPUT=/dev/null "$@" bash "$SMOKE" 2>&1)" || status=$?
  if [[ "$status" != "$want" ]]; then
    failed=$((failed + 1)); echo "  FAIL $name: exit $status, expected $want"; indent "$out"
  elif [[ -n "$pattern" ]] && ! grep -qE -- "$pattern" <<< "$out"; then
    failed=$((failed + 1)); echo "  FAIL $name: output lacks /$pattern/"; indent "$out"
  else
    pass=$((pass + 1)); echo "  ok   $name"
  fi
}

echo "image-smoke"
expect "baked revision passes" 0 '^healthy: .*"revision":"'"$REV"'"'
expect "wrong revision fails" 1 'reports revision .*expected "other"' REVISION=other
expect "runtime revision without inject fails" 1 'reports revision ""' IMAGE="$TAG-norev"
expect "inject-revision feeds the runtime revision" 0 '^healthy' IMAGE="$TAG-norev" INJECT_REVISION=true
expect "slow start waits" 0 'waiting for health.*' ENV_INPUT="PORT=$PORT
READY_AFTER_MS=1500"
expect "status not ok never passes" 1 'never answered ok' TRIES=3 INTERVAL=0.2 ENV_INPUT="PORT=$PORT
HEALTH_STATUS=starting"
expect "non-JSON body fails" 1 'not a JSON object' ENV_INPUT="PORT=$PORT
RAW_BODY=fine"
expect "crashing container fails with logs" 1 'crashing on purpose' ENV_INPUT="PORT=$PORT
CRASH=1"
expect "invalid env line fails" 1 'invalid env line: not valid' ENV_INPUT="not valid"
expect "env-secrets are masked" 0 '::add-mask::s3cr3t value' ENV_SECRETS="TOKEN=s3cr3t value"
expect "comments and blank lines in env are ignored" 0 '^healthy' ENV_INPUT="# comment

PORT=$PORT"
expect "smoke command gets SMOKE_URL" 0 '^healthy' SMOKE_COMMAND='curl -fsS --max-time 5 "$SMOKE_URL/api/health" | grep -q revision'
expect "failing smoke command fails" 1 'smoke command failed' SMOKE_COMMAND='exit 3'
expect "run-args keep spaces per line" 0 '^healthy' RUN_ARGS='--label
fixture=a b c' SMOKE_COMMAND='[[ "$(docker inspect -f "{{index .Config.Labels \"fixture\"}}" "$SMOKE_CONTAINER")" == "a b c" ]]'
expect "memory limit applied" 0 '^healthy' MEMORY=64m SMOKE_COMMAND='[[ "$(docker inspect -f "{{.HostConfig.Memory}}" "$SMOKE_CONTAINER")" == 67108864 ]]'
expect "invalid tries rejected" 1 'tries must be a positive number' TRIES=0

leftover="$(docker ps -aq --filter "ancestor=$TAG")$(docker ps -aq --filter "ancestor=$TAG-norev")"
if [[ -z "$leftover" ]]; then pass=$((pass + 1)); echo "  ok   no containers left behind"
else failed=$((failed + 1)); echo "  FAIL containers left behind: $leftover"; fi

echo
echo "passed: $pass  failed: $failed"
(( failed == 0 ))
