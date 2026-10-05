#!/usr/bin/env bash
# Starts Postgres/Mailpit/compose services and waits for health.
set -euo pipefail

: "${WAIT_SECONDS:=60}"
: "${POSTGRES_MODE:=container}"
: "${GITHUB_OUTPUT:=/dev/stdout}"
: "${GITHUB_PATH:=/dev/null}"
out() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }

[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || { echo "::error::wait-seconds must be a number: ${WAIT_SECONDS}"; exit 1; }

suffix="${NAME_SUFFIX:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-job}}"
suffix="$(printf '%s' "$suffix" | tr -c 'A-Za-z0-9_.-' '-' | tr '[:upper:]' '[:lower:]')"

urlencode() {
  local s="$1" i c encoded=""
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) encoded+="$c" ;;
      *) encoded+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$encoded"
}

wait_for() { # wait_for <label> <container|""> <cmd...>
  local name="$1" container="$2"; shift 2
  local deadline=$((SECONDS + WAIT_SECONDS))
  until "$@" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "::error::${name} not healthy after ${WAIT_SECONDS}s"
      [[ -n "$container" ]] && docker logs "$container" 2>&1 | tail -n 50
      exit 1
    fi
    sleep 1
  done
  echo "${name} ready"
}

as_root() { if (( EUID == 0 )); then "$@"; else sudo "$@"; fi; }

if [[ -n "${POSTGRES_VERSION:-}" ]]; then
  case "$POSTGRES_MODE" in
    container)
      pg="ci-postgres-${suffix}"
      docker rm --force --volumes "$pg" >/dev/null 2>&1 || true
      docker run -d --name "$pg" \
        -p "${POSTGRES_PORT}:5432" \
        -e "POSTGRES_USER=${POSTGRES_USER}" \
        -e "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
        -e "POSTGRES_DB=${POSTGRES_DB}" \
        "postgres:${POSTGRES_VERSION}" >/dev/null
      # TCP, not the socket: the init phase server listens on the socket only, then restarts
      wait_for "postgres:${POSTGRES_VERSION}" "$pg" \
        docker exec "$pg" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"

      while IFS= read -r db; do
        db="${db//[[:space:]]/}"
        [[ -n "$db" ]] || continue
        [[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "::error::invalid database name: ${db}"; exit 1; }
        docker exec "$pg" createdb -h 127.0.0.1 -U "$POSTGRES_USER" "$db"
        echo "created database ${db}"
      done < <(tr ',' '\n' <<< "${POSTGRES_EXTRA_DATABASES:-}")

      out postgres-container "$pg"
      out database-url "postgresql://$(urlencode "$POSTGRES_USER"):$(urlencode "$POSTGRES_PASSWORD")@127.0.0.1:${POSTGRES_PORT}/$(urlencode "$POSTGRES_DB")"
      ;;
    binaries)
      major="${POSTGRES_VERSION%%[!0-9]*}"
      [[ -n "$major" ]] || { echo "::error::binaries mode needs a numeric postgres-version: ${POSTGRES_VERSION}"; exit 1; }
      command -v apt-get >/dev/null || { echo "::error::binaries mode needs apt (Debian/Ubuntu runner)"; exit 1; }
      export DEBIAN_FRONTEND=noninteractive
      if [[ ! -x /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]]; then
        as_root apt-get update -q
        as_root apt-get install -y -q --no-install-recommends postgresql-common
      fi
      # Binaries only: the caller creates its own clusters
      as_root sed -i -E 's/^#?[[:space:]]*create_main_cluster[[:space:]]*=.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
      grep -q '^create_main_cluster = false' /etc/postgresql-common/createcluster.conf \
        || echo 'create_main_cluster = false' | as_root tee -a /etc/postgresql-common/createcluster.conf >/dev/null
      as_root /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
      as_root apt-get install -y -q --no-install-recommends "postgresql-${major}"
      bin="/usr/lib/postgresql/${major}/bin"
      "$bin/postgres" --version
      echo "$bin" >> "$GITHUB_PATH"
      out database-url ""
      ;;
    *) echo "::error::invalid postgres-mode: ${POSTGRES_MODE} (container, binaries)"; exit 1 ;;
  esac
fi

if [[ -n "${MAILPIT_VERSION:-}" ]]; then
  mp="ci-mailpit-${suffix}"
  docker rm --force --volumes "$mp" >/dev/null 2>&1 || true
  docker run -d --name "$mp" \
    -p "${MAILPIT_SMTP_PORT}:1025" \
    -p "${MAILPIT_HTTP_PORT}:8025" \
    "axllent/mailpit:${MAILPIT_VERSION}" >/dev/null
  wait_for "mailpit:${MAILPIT_VERSION}" "$mp" curl -fs --max-time 5 "http://127.0.0.1:${MAILPIT_HTTP_PORT}/readyz"
  out mailpit-container "$mp"
fi

if [[ -n "${COMPOSE_FILE_INPUT:-}" ]]; then
  [[ -f "$COMPOSE_FILE_INPUT" ]] || { echo "::error::compose file not found: ${COMPOSE_FILE_INPUT}"; exit 1; }
  project="ci-${suffix}"
  docker compose -p "$project" -f "$COMPOSE_FILE_INPUT" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if ! docker compose -p "$project" -f "$COMPOSE_FILE_INPUT" up -d --wait --wait-timeout "$WAIT_SECONDS"; then
    echo "::error::compose services not healthy after ${WAIT_SECONDS}s"
    docker compose -p "$project" -f "$COMPOSE_FILE_INPUT" ps || true
    docker compose -p "$project" -f "$COMPOSE_FILE_INPUT" logs --tail 50 || true
    exit 1
  fi
  out compose-project "$project"
fi
