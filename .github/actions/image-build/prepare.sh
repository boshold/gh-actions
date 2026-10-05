#!/usr/bin/env bash
# Resolves image refs, build args, labels and attestation settings for build-push-action.
set -euo pipefail

: "${CONTEXT:=.}"
: "${GITHUB_OUTPUT:=/dev/stdout}"
out() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }
out_multi() {
  local delimiter
  delimiter="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s<<%s\n%s\n%s\n' "$1" "$delimiter" "$2" "$delimiter" >> "$GITHUB_OUTPUT"
}

[[ -d "$CONTEXT" ]] || { echo "::error::context not found: ${CONTEXT}"; exit 1; }
dockerfile="${DOCKERFILE:-${CONTEXT%/}/Dockerfile}"
[[ -f "$dockerfile" ]] || { echo "::error::Dockerfile not found: ${dockerfile}"; exit 1; }
out dockerfile "$dockerfile"

image="${IMAGE:-ghcr.io/${GITHUB_REPOSITORY:?}}"
image="${image,,}"
[[ -n "${REVISION:-}" ]] || { echo "::error::revision is empty"; exit 1; }

refs=()
while IFS= read -r tag; do
  tag="${tag//[[:space:]]/}"
  [[ -n "$tag" ]] || continue
  if [[ "$tag" == */* || "$tag" == *:* ]]; then refs+=("$tag"); else refs+=("${image}:${tag}"); fi
done <<< "${TAGS:-}"
(( ${#refs[@]} )) || refs=("${image}:sha-${REVISION}")
out image "${refs[0]}"
out_multi refs "$(printf '%s\n' "${refs[@]}")"

args=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || { echo "::error::invalid build-args line: ${line}"; exit 1; }
  args+=("$line")
done <<< "${BUILD_ARGS:-}"
args+=("DEPLOYMENT_REVISION=${REVISION}")
[[ -n "${VERSION:-}" ]] && args+=("APP_VERSION=${VERSION}")
out_multi build-args "$(printf '%s\n' "${args[@]}")"

labels=("org.opencontainers.image.revision=${REVISION}")
[[ -n "${GITHUB_REPOSITORY:-}" ]] && labels+=("org.opencontainers.image.source=${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}")
[[ -n "${VERSION:-}" ]] && labels+=("org.opencontainers.image.version=${VERSION}")
out_multi labels "$(printf '%s\n' "${labels[@]}")"

load="${LOAD:-}"
if [[ -z "$load" ]]; then
  if [[ "${PUSH:-false}" == true ]]; then load=false; else load=true; fi
fi
out load "$load"

scope="${CACHE_SCOPE:-$dockerfile}"
scope="$(printf '%s' "$scope" | tr -c 'A-Za-z0-9_.-' '-')"
out cache-scope "$scope"

case "${PROVENANCE:-min}" in
  min|max) provenance="mode=${PROVENANCE:-min}" ;;
  false) provenance=false ;;
  *) echo "::error::invalid provenance: ${PROVENANCE} (min, max, false)"; exit 1 ;;
esac
# Attestations need a registry push; the docker exporter (load) drops them anyway
if [[ "${PUSH:-false}" == true ]]; then
  out provenance "$provenance"
  out sbom "${SBOM:-false}"
else
  out provenance false
  out sbom false
fi
