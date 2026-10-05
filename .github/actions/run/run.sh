#!/usr/bin/env bash
# Applies ENV_INPUT/ENV_SECRETS, optionally exports them, then runs CMD.
set -euo pipefail

: "${GITHUB_ENV:=/dev/null}"

keys=()
values=()

# parse <input> <secret:true|false>
parse() {
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      # Never echo a secret line
      if [[ "$2" == true ]]; then echo "::error::invalid env-secrets line (expected KEY=VALUE)"; else echo "::error::invalid env line: ${line}"; fi
      exit 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$2" == true && -n "$value" ]]; then echo "::add-mask::${value}"; fi
    keys+=("$key")
    values+=("$value")
  done <<< "$1"
}

parse "${ENV_INPUT:-}" false
parse "${ENV_SECRETS:-}" true

for i in "${!keys[@]}"; do
  export "${keys[$i]}=${values[$i]}"
  if [[ "${EXPORT:-false}" == true ]]; then
    delimiter="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    printf '%s<<%s\n%s\n%s\n' "${keys[$i]}" "$delimiter" "${values[$i]}" "$delimiter" >> "$GITHUB_ENV"
  fi
done

[[ -n "${CMD:-}" ]] || exit 0
[[ -n "${LABEL:-}" ]] && echo "::group::${LABEL}"
status=0
bash -euo pipefail -c "$CMD" || status=$?
[[ -n "${LABEL:-}" ]] && echo "::endgroup::"
exit "$status"
