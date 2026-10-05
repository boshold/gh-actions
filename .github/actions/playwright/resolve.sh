#!/usr/bin/env bash
# Resolves the installed Playwright version, browser cache path and cache toggle.
set -euo pipefail

: "${GITHUB_OUTPUT:=/dev/stdout}"
out() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }

version=""
for pkg in @playwright/test playwright playwright-core; do
  version="$(node -e 'try { process.stdout.write(require(process.argv[1] + "/package.json").version) } catch {}' "$pkg")"
  [[ -n "$version" ]] && break
done
[[ -n "$version" ]] || { echo "::error::Playwright not resolvable from $(pwd); install dependencies first"; exit 1; }
echo "playwright ${version}"
out version "$version"

if [[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  path="$PLAYWRIGHT_BROWSERS_PATH"
else
  case "${RUNNER_OS:-Linux}" in
    macOS) path="$HOME/Library/Caches/ms-playwright" ;;
    Windows) path="${LOCALAPPDATA:-$HOME/AppData/Local}/ms-playwright" ;;
    *) path="$HOME/.cache/ms-playwright" ;;
  esac
fi
out path "$path"

read -r -a browsers <<< "${BROWSERS:-chromium}"
for b in "${browsers[@]}"; do
  [[ "$b" =~ ^[a-z0-9_-]+$ ]] || { echo "::error::invalid browser: ${b}"; exit 1; }
done
key="$(printf '%s\n' "${browsers[@]}" | sort -u | paste -sd- -)"
out browsers-key "$key"

case "${CACHE:-auto}" in
  auto) if [[ "${CI_LOCAL_CACHE:-}" == "1" ]]; then out cache false; else out cache true; fi ;;
  off) out cache false ;;
  *) echo "::error::invalid cache: ${CACHE} (auto, off)"; exit 1 ;;
esac
