#!/usr/bin/env bash
# Starts an Umbraco site in a routine session, on SQLite or SQL Server, and waits until it
# answers. stacks/umbraco/setup.sh copies this to ~/.loop/ when the environment is built.
#
# Usage: run-umbraco.sh --boot "<command>" [--provider sqlite|sqlserver] [--port 44380] [--ready-path <path>]
#   --boot        required: how this repo starts its site, such as
#                 "dotnet run --project src/Site/Site.csproj --no-launch-profile".
#                 It must honour ASPNETCORE_URLS.
#   --provider    sqlite (default): the site keeps its own connection string.
#                 sqlserver: a SQL Server 2022 container, from the image setup.sh cached. The
#                 site gets it through ConnectionStrings__umbracoDbDSN, so no file in the repo
#                 changes.
#   --port        HTTPS port (default 44380).
#   --ready-path  what to poll (default Umbraco's server status endpoint).
#
# Prints the base URL when ready and leaves the site running. Its boot log is
# /tmp/umbraco-run.log.
#
# The SQL Server password is generated per container, never a fixed string.
set -uo pipefail

PROVIDER="sqlite"
BOOT=""
PORT="${LOOP_UMBRACO_PORT:-44380}"
READY_PATH="/umbraco/management/api/v1/server/status"
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --boot) BOOT="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --ready-path) READY_PATH="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"

MSSQL_IMAGE="mcr.microsoft.com/mssql/server:2022-latest"
MSSQL_DB="${LOOP_MSSQL_DB:-umbraco-local}"
DOCKER_DATA_ROOT="${DOCKER_DATA_ROOT:-/root/.docker-data}"
RUN_DIR="${LOOP_RUN_DIR:-/tmp}"
PASSFILE="$RUN_DIR/loop-mssql.pass"
BOOT_LOG="$RUN_DIR/umbraco-run.log"

[ -n "$BOOT" ] || { echo "ERROR: --boot \"<command>\" is required: how this repo starts its site" >&2; exit 1; }
case "$PROVIDER" in
  sqlite | sqlserver) ;;
  *) echo "ERROR: unknown --provider \"$PROVIDER\" (use sqlite or sqlserver)" >&2; exit 1 ;;
esac
command -v dotnet >/dev/null 2>&1 || { echo "ERROR: dotnet isn't on PATH; stacks/umbraco/setup.sh installs it" >&2; exit 1; }

ensure_docker() {
  if docker info >/dev/null 2>&1; then return 0; fi
  if ! command -v docker >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || { echo "ERROR: no Docker, and no apt-get to install it"; return 1; }
    (apt-get update -qq && apt-get install -y docker.io) || echo "WARNING: installing Docker failed"
  fi
  mkdir -p "$DOCKER_DATA_ROOT"
  service docker stop >/dev/null 2>&1 || true
  (nohup dockerd --data-root "$DOCKER_DATA_ROOT" >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || {
    echo "ERROR: Docker won't run in this environment (see /tmp/dockerd.log). Use --provider sqlite, and treat CI as the SQL Server check."
    return 1
  }
}

mkdir -p "$RUN_DIR"

if [ "$PROVIDER" = "sqlserver" ]; then
  ensure_docker || exit 1
  # Reuse a running container only if this script started it and still has its password.
  if docker ps --format '{{.Names}}' | grep -qx mssql && [ -s "$PASSFILE" ]; then
    SA_PASSWORD="$(cat "$PASSFILE")"
    echo "SQL Server container already running; reusing it"
  else
    SA_PASSWORD="Loop-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')-9Q"
    printf '%s' "$SA_PASSWORD" > "$PASSFILE"
    chmod 600 "$PASSFILE" 2>/dev/null || true
    docker rm -f mssql >/dev/null 2>&1 || true
    docker run -d --name mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=$SA_PASSWORD" -p 1433:1433 "$MSSQL_IMAGE" >/dev/null \
      || { echo "ERROR: could not start the SQL Server container"; exit 1; }
  fi
  echo "waiting for SQL Server..."
  ready=0
  for _ in $(seq 1 "${LOOP_SQL_TRIES:-40}"); do
    if docker exec mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASSWORD" -C -Q "SELECT 1" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep "${LOOP_SQL_SLEEP:-3}"
  done
  [ "$ready" -eq 1 ] || { echo "ERROR: SQL Server didn't become ready"; docker logs --tail 40 mssql; exit 1; }
  export ConnectionStrings__umbracoDbDSN="Server=localhost,1433;Database=$MSSQL_DB;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=True"
  export ConnectionStrings__umbracoDbDSN_ProviderName="Microsoft.Data.SqlClient"
fi

dotnet dev-certs https >/dev/null 2>&1 || true

echo "starting Umbraco ($PROVIDER)..."
ASPNETCORE_URLS="https://localhost:$PORT" nohup bash -c "$BOOT" > "$BOOT_LOG" 2>&1 &
base=""
for i in $(seq 1 "${LOOP_READY_TRIES:-90}"); do
  if curl -ksf "https://localhost:$PORT$READY_PATH" >/dev/null 2>&1; then
    base="https://localhost:$PORT"
    break
  fi
  if [ $((i % 6)) -eq 0 ]; then
    echo "still starting..."
    tail -n 1 "$BOOT_LOG" 2>/dev/null
  fi
  sleep "${LOOP_READY_SLEEP:-5}"
done
[ -n "$base" ] || { echo "ERROR: Umbraco didn't become ready. Boot log:"; tail -n 40 "$BOOT_LOG"; exit 1; }

printf '%s' "$base" > "$RUN_DIR/umbraco-base-url"
echo "Umbraco ($PROVIDER) ready at $base"
