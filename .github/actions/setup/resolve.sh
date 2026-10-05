#!/usr/bin/env bash
# Resolves setup-node/pnpm/bun inputs. Writes step outputs.
set -euo pipefail

: "${WORKDIR:=.}"
: "${GITHUB_OUTPUT:=/dev/stdout}"
out() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }
rel() { if [[ "$WORKDIR" == "." ]]; then printf '%s' "$1"; else printf '%s/%s' "${WORKDIR%/}" "$1"; fi; }

[[ -d "$WORKDIR" ]] || { echo "::error::working-directory not found: ${WORKDIR}"; exit 1; }

# Node: explicit > .nvmrc > .node-version > package.json (engines/volta/devEngines) > 24
if [[ -n "${NODE_VERSION:-}" ]]; then
  out node-version "$NODE_VERSION"
  out node-version-file ""
else
  file=""
  for candidate in .nvmrc .node-version; do
    [[ -s "$(rel "$candidate")" ]] && { file="$(rel "$candidate")"; break; }
  done
  if [[ -z "$file" && -f "$(rel package.json)" ]] && grep -qE '"(engines|volta|devEngines)"[[:space:]]*:' "$(rel package.json)"; then
    file="$(rel package.json)"
  fi
  if [[ -n "$file" ]]; then
    echo "node version from ${file}"
    out node-version ""
    out node-version-file "$file"
  else
    out node-version 24
    out node-version-file ""
  fi
fi

# packageManager and lockfile: working-directory first, then the repository root (monorepo app)
package_json=package.json
[[ -f "$(rel package.json)" ]] && grep -q '"packageManager"' "$(rel package.json)" && package_json="$(rel package.json)"
out package-json "$package_json"
lockfile=""
if [[ -f "$(rel pnpm-lock.yaml)" ]]; then lockfile="$(rel pnpm-lock.yaml)"
elif [[ -f pnpm-lock.yaml ]]; then lockfile=pnpm-lock.yaml; fi
out lockfile "$lockfile"

case "${CACHE:-auto}" in
  auto) if [[ "${CI_LOCAL_CACHE:-}" == "1" ]]; then out node-cache ""; else out node-cache pnpm; fi ;;
  off) out node-cache "" ;;
  *) echo "::error::invalid cache: ${CACHE} (auto, off)"; exit 1 ;;
esac

owner="${OWNER:-${GITHUB_REPOSITORY_OWNER:-}}"
owner="${owner,,}"
case "${REGISTRY:-github}" in
  github)
    [[ -n "${SCOPE:-}" || -n "$owner" ]] || { echo "::error::scope is empty and the repository owner is unknown"; exit 1; }
    out registry-url https://npm.pkg.github.com
    out scope "${SCOPE:-@${owner}}"
    ;;
  npmjs)
    # Public npm needs no .npmrc; only write one for a scope or a token
    if [[ -n "${SCOPE:-}" || "${HAS_TOKEN:-false}" == true ]]; then
      out registry-url https://registry.npmjs.org
    else
      out registry-url ""
    fi
    out scope "${SCOPE:-}"
    ;;
  *) echo "::error::invalid registry: ${REGISTRY} (github, npmjs)"; exit 1 ;;
esac

if [[ "${BUN:-}" == "file" ]]; then
  [[ -s "$(rel .bun-version)" ]] || { echo "::error::bun: file, but $(rel .bun-version) is missing"; exit 1; }
  out bun-version ""
  out bun-version-file "$(rel .bun-version)"
else
  out bun-version "${BUN:-}"
  out bun-version-file ""
fi
