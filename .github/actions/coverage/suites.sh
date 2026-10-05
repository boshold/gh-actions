#!/usr/bin/env bash
# Maps SUMMARIES lines ("[label=]path") to outputs summary-N/final-N/name-N (N = 1..5).
set -euo pipefail

: "${GITHUB_OUTPUT:=/dev/stdout}"
: "${NAME:=Coverage}"
max=5

labels=()
paths=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -n "$line" && "$line" != \#* ]] || continue
  if [[ "$line" == *=* ]]; then
    label="${line%%=*}"; path="${line#*=}"
  else
    # packages/core/coverage/coverage-summary.json -> core; coverage/unit/coverage-summary.json -> unit
    path="$line"; dir="$(dirname "$path")"
    [[ "$(basename "$dir")" == coverage ]] && dir="$(dirname "$dir")"
    label="$(basename "$dir")"
    [[ "$label" == . ]] && label="$path"
  fi
  if [[ ! -f "$path" ]]; then
    echo "::notice::no coverage summary at ${path}; skipping"
    continue
  fi
  labels+=("$label")
  paths+=("$path")
done <<< "${SUMMARIES:-}"

if (( ${#paths[@]} > max )); then
  echo "::warning::only the first ${max} coverage suites are reported"
fi

for (( i = 0; i < ${#paths[@]} && i < max; i++ )); do
  n=$((i + 1))
  final="$(dirname "${paths[$i]}")/coverage-final.json"
  [[ -f "$final" ]] || final=""
  name="$NAME"
  (( ${#paths[@]} > 1 )) && name="${NAME}: ${labels[$i]}"
  {
    printf 'summary-%s=%s\n' "$n" "${paths[$i]}"
    printf 'final-%s=%s\n' "$n" "$final"
    printf 'name-%s=%s\n' "$n" "$name"
  } >> "$GITHUB_OUTPUT"
done
