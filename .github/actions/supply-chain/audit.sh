#!/usr/bin/env bash
# pnpm audit in every AUDIT_DIRS entry; fails after all directories ran.
set -euo pipefail

case "${AUDIT_LEVEL:=high}" in
  low|moderate|high|critical) ;;
  *) echo "::error::invalid audit-level: ${AUDIT_LEVEL} (low, moderate, high, critical)"; exit 1 ;;
esac
args=(audit --audit-level "$AUDIT_LEVEL")
[[ "${AUDIT_PROD:-false}" == true ]] && args+=(--prod)

failed=()
while IFS= read -r dir; do
  dir="${dir%$'\r'}"
  [[ -n "${dir//[[:space:]]/}" ]] || continue
  [[ -d "$dir" ]] || { echo "::error::audit directory not found: ${dir}"; exit 1; }
  echo "::group::pnpm audit (${dir})"
  status=0
  (cd "$dir" && pnpm "${args[@]}") || status=$?
  echo "::endgroup::"
  if (( status )); then
    echo "::error::pnpm audit found ${AUDIT_LEVEL}+ advisories in ${dir}"
    failed+=("$dir")
  fi
done <<< "${AUDIT_DIRS:-.}"

(( ${#failed[@]} == 0 ))
