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

case "${PUSH_BY_DIGEST:-false}" in
  true|false) by_digest="${PUSH_BY_DIGEST:-false}" ;;
  *) echo "::error::invalid push-by-digest: ${PUSH_BY_DIGEST} (true, false)"; exit 1 ;;
esac
pushing="${PUSH:-false}"
[[ "$by_digest" == true ]] && pushing=true
out name "$image"

refs=()
while IFS= read -r tag; do
  tag="${tag//[[:space:]]/}"
  [[ -n "$tag" ]] || continue
  if [[ "$tag" == */* || "$tag" == *:* ]]; then refs+=("$tag"); else refs+=("${image}:${tag}"); fi
done <<< "${TAGS:-}"
(( ${#refs[@]} )) || refs=("${image}:sha-${REVISION}")
if [[ "$by_digest" == true ]]; then
  tags_input="${TAGS:-}"
  [[ -z "${tags_input//[[:space:]]/}" ]] || { echo "::error::push-by-digest creates no tags; tag the digest later (docker buildx imagetools create)"; exit 1; }
  # Untagged push; image and refs become <image>@<digest> after the build
  out push false
  out tags ""
  out outputs "type=image,name=${image},push-by-digest=true,name-canonical=true,push=true"
else
  out push "${PUSH:-false}"
  out_multi tags "$(printf '%s\n' "${refs[@]}")"
  out outputs ""
  out image "${refs[0]}"
  out_multi refs "$(printf '%s\n' "${refs[@]}")"
fi

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
  if [[ "$pushing" == true ]]; then load=false; else load=true; fi
fi
[[ "$by_digest" == true && "$load" == true ]] && { echo "::error::push-by-digest cannot load; pull <image>@<digest> instead"; exit 1; }
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
if [[ "$pushing" == true ]]; then
  out provenance "$provenance"
  out sbom "${SBOM:-false}"
else
  out provenance false
  out sbom false
fi
