#!/usr/bin/env bash
# Packs and publishes packages in order; skips versions already on the registry.
set -euo pipefail

: "${REGISTRY:=npmjs}"
: "${ACCESS:=public}"
: "${PROVENANCE:=auto}"
: "${DRY_RUN:=false}"
: "${STAGE:=false}"
: "${GITHUB_OUTPUT:=/dev/null}"
: "${GITHUB_STEP_SUMMARY:=/dev/null}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper() { node "$HERE/helper.mjs" "$@"; }

case "$REGISTRY" in
  npmjs) registry_url=https://registry.npmjs.org/ ;;
  github) registry_url=https://npm.pkg.github.com/ ;;
  *) echo "::error::invalid registry: ${REGISTRY} (npmjs, github)"; exit 1 ;;
esac
[[ "$STAGE" != true || "$REGISTRY" == npmjs ]] || { echo "::error::stage needs registry npmjs"; exit 1; }

oidc=false
[[ "$REGISTRY" == npmjs && -z "${PUBLISH_TOKEN:-}" ]] && oidc=true
if [[ "$oidc" == true && "$DRY_RUN" != true && -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
  echo "::error::npmjs without a token uses trusted publishing (OIDC); grant the job permissions id-token: write or pass a token"
  exit 1
fi

# --- npm version -------------------------------------------------------------
if [[ -n "${NPM_VERSION:-}" ]]; then
  [[ "$NPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::npm-version must be X.Y.Z: ${NPM_VERSION}"; exit 1; }
  if helper lt "$(npm --version)" "$NPM_VERSION"; then
    echo "installing npm@${NPM_VERSION} (have $(npm --version))"
    npm install --global --no-audit --no-fund "npm@${NPM_VERSION}" >/dev/null
  fi
fi
npm_version="$(npm --version)"
if [[ "$oidc" == true && "$DRY_RUN" != true ]] && helper lt "$npm_version" 11.5.1; then
  echo "::error::trusted publishing needs npm >= 11.5.1, got ${npm_version}; set npm-version"
  exit 1
fi
if [[ "$STAGE" == true && "$DRY_RUN" != true ]] && helper lt "$npm_version" 11.15.0; then
  echo "::error::npm stage publish needs npm >= 11.15.0, got ${npm_version}; set npm-version"
  exit 1
fi

provenance=false
case "$PROVENANCE" in
  auto) [[ "$REGISTRY" == npmjs && "${REPO_PRIVATE:-}" == false && -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] && provenance=true ;;
  true) provenance=true ;;
  false) ;;
  *) echo "::error::invalid provenance: ${PROVENANCE} (auto, true, false)"; exit 1 ;;
esac

# --- auth: own userconfig, token only in the npm process env -----------------
npmrc="$(mktemp)"
trap 'rm -f "$npmrc"' EXIT
host="${registry_url#https:}"
if [[ -n "${PUBLISH_TOKEN:-}" ]]; then
  # shellcheck disable=SC2016 # npm expands it from the process env
  printf '%s:_authToken=${NODE_AUTH_TOKEN}\n' "$host" > "$npmrc"
fi
npm_() { NPM_CONFIG_USERCONFIG="$npmrc" NODE_AUTH_TOKEN="${PUBLISH_TOKEN:-}" npm "$@"; }

# --- package list --------------------------------------------------------------
mapfile -t entries < <(helper list "${PACKAGES:-}")
(( ${#entries[@]} )) || { echo "::error::no package to publish; every workspace package is private"; exit 1; }

out_dir="$(pwd)/.npm-publish"
# Never wipe it when given tarballs, they may live there
if ! printf '%s\n' "${entries[@]}" | grep -q '\.tgz$'; then rm -rf "$out_dir"; fi
mkdir -p "$out_dir"

published=()
skipped=()
rows=()
i=0
for entry in "${entries[@]}"; do
  i=$((i + 1))
  if [[ "$entry" == *.tgz ]]; then
    [[ -f "$entry" ]] || { echo "::error::tarball not found: ${entry}"; exit 1; }
    tarball="$entry"
  else
    [[ -f "$entry/package.json" ]] || { echo "::error::no package.json in ${entry}"; exit 1; }
    rm -rf "${out_dir:?}/$i" && mkdir -p "$out_dir/$i"
    # pnpm pack resolves workspace: and catalog: ranges
    (cd "$entry" && pnpm pack --pack-destination "$out_dir/$i" >/dev/null)
    tarball="$(find "$out_dir/$i" -maxdepth 1 -name '*.tgz' | head -n 1)"
    [[ -n "$tarball" ]] || { echo "::error::pnpm pack produced no tarball in ${entry}"; exit 1; }
  fi
  read -r name version private publish_registry < <(tar -xzOf "$tarball" package/package.json | helper manifest) || true
  [[ -n "${name:-}" && -n "${version:-}" ]] || { echo "::error::cannot read package.json from ${tarball}"; exit 1; }
  [[ "$private" == true ]] && { echo "::error::${name} is private and cannot be published"; exit 1; }
  if [[ -n "${EXPECTED_VERSION:-}" && "$version" != "$EXPECTED_VERSION" ]]; then
    echo "::error::${name} has version ${version}, expected ${EXPECTED_VERSION}"
    exit 1
  fi
  if [[ "$publish_registry" != - && "${publish_registry%/}/" != "$registry_url" ]]; then
    echo "::warning::${name} publishConfig.registry is ${publish_registry}, publishing to ${registry_url}"
  fi

  # npm view exits 0 with empty output for a missing version of a known package
  existing="$(npm_ view "${name}@${version}" version --registry "$registry_url" 2>/dev/null || true)"
  if [[ "$existing" == "$version" ]]; then
    echo "${name}@${version} is already on ${registry_url}, skipping"
    skipped+=("${name}@${version}")
    rows+=("| \`${name}@${version}\` | skipped (already published) |")
    continue
  fi

  tag="${DIST_TAG:-$(helper dist-tag "$version")}"
  args=("./${tarball#./}" --registry "$registry_url" --tag "$tag" "--provenance=${provenance}")
  [[ "$tarball" == /* ]] && args[0]="$tarball"
  [[ "$REGISTRY" == npmjs ]] && args+=(--access "$ACCESS")

  if [[ "$DRY_RUN" == true ]]; then
    npm_ publish "${args[@]}" --dry-run
    result="dry run (${tag})"
  elif [[ "$STAGE" == true ]]; then
    npm_ stage publish "${args[@]}"
    result="staged (${tag})"
  else
    npm_ publish "${args[@]}"
    result="published (${tag})"
  fi
  published+=("${name}@${version}")
  rows+=("| \`${name}@${version}\` | ${result} |")
done

printf 'published=%s\n' "$(helper json "${published[@]}")" >> "$GITHUB_OUTPUT"
printf 'skipped=%s\n' "$(helper json "${skipped[@]}")" >> "$GITHUB_OUTPUT"
{
  echo "### npm publish (${REGISTRY})"
  echo
  echo "| Package | Result |"
  echo "| --- | --- |"
  printf '%s\n' "${rows[@]}"
  if [[ "$STAGE" == true && "$DRY_RUN" != true && ${#published[@]} -gt 0 ]]; then
    echo
    echo "Staged versions stay hidden until approved on npmjs.com or with \`npm stage approve\`, in the order above."
  fi
} >> "$GITHUB_STEP_SUMMARY"
