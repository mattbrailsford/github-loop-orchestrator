#!/usr/bin/env bash
# Prepares a routine's cloud environment to build and run an Umbraco site. Optional: call it
# from the bottom of templates/cloud-setup.sh when the routine's repos are Umbraco packages.
#
# Usage: setup.sh [--channel 10.0] [--provider sqlite|sqlserver]
#   --channel    the .NET SDK major.minor from the repo's global.json (default 10.0, or
#                $DOTNET_CHANNEL).
#   --provider   sqlite (default): SDK only; sites run on SQLite.
#                sqlserver: also Docker and a cached SQL Server 2022 image (~2.3 GB), for
#                CI-parity runs.
#
# It installs only what's slow and needs no credentials, so it caches with the environment:
#   1. the .NET SDK, in ~/.dotnet, linked onto PATH
#   2. for sqlserver, Docker and the mssql image, in Docker's persistent store
#   3. run-umbraco.sh, in ~/.loop/, which a session uses to start a site
# and adds an "Umbraco" section to ~/loop-env-manifest.md saying what's really there.
#
# Allowed domains it needs: raw.githubusercontent.com, builds.dotnet.microsoft.com, ci.dot.net,
# and, for Umbraco's prerelease NuGet feeds, myget.org and www.myget.org. For sqlserver, also
# mcr.microsoft.com and the apt mirrors.
#
# Never fails the environment build: the manifest and the log say what's missing.
# Env, for tests: LOOP_HOME (instead of $HOME), LOOP_BIN_DIR (instead of /usr/local/bin).
set -uo pipefail

HOME_DIR="${LOOP_HOME:-$HOME}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME_DIR/loop-setup.log"
MANIFEST="$HOME_DIR/loop-env-manifest.md"
SCRIPTS_DIR="$HOME_DIR/.loop"
BIN_DIR="${LOOP_BIN_DIR:-/usr/local/bin}"
MSSQL_IMAGE="mcr.microsoft.com/mssql/server:2022-latest"
# Fixed, and matching run-umbraco.sh, so a session's Docker sees the image cached here.
DOCKER_DATA_ROOT="${DOCKER_DATA_ROOT:-/root/.docker-data}"

CHANNEL="${DOTNET_CHANNEL:-10.0}"
PROVIDER="${DB_PROVIDER:-sqlite}"
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

export DOTNET_ROOT="$HOME_DIR/.dotnet"
export PATH="$HOME_DIR/.dotnet:$HOME_DIR/.dotnet/tools:$PATH"

log() { printf '%s %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$*" >> "$LOG"; }

has_channel() { dotnet --list-sdks 2>/dev/null | grep -q "^${CHANNEL}\."; }

# .bashrc isn't read by a backgrounded `nohup dotnet run`, so dotnet has to be on a PATH folder
# every shell sees.
link_dotnet() {
  [ -x "$HOME_DIR/.dotnet/dotnet" ] && ln -sf "$HOME_DIR/.dotnet/dotnet" "$BIN_DIR/dotnet" 2>/dev/null
  return 0
}

install_dotnet() {
  if has_channel; then
    log ".NET SDK $CHANNEL already present"
    link_dotnet
    return 0
  fi
  log "installing .NET SDK $CHANNEL"
  local tmp
  tmp="$(mktemp -d)/dotnet-install.sh"
  # The raw GitHub URL, not dot.net/v1, which redirects and can leave curl with an empty file.
  if ! curl -fsSL -o "$tmp" https://raw.githubusercontent.com/dotnet/install-scripts/main/src/dotnet-install.sh; then
    log "WARNING: could not download dotnet-install.sh; check the allowed domains"
    return 1
  fi
  chmod +x "$tmp"
  "$tmp" --channel "$CHANNEL" --install-dir "$HOME_DIR/.dotnet" >> "$LOG" 2>&1 || {
    log "WARNING: the .NET SDK install failed"
    return 1
  }
  if ! grep -q 'DOTNET_ROOT=$HOME/.dotnet' "$HOME_DIR/.bashrc" 2>/dev/null; then
    {
      echo 'export DOTNET_ROOT=$HOME/.dotnet'
      echo 'export PATH=$HOME/.dotnet:$HOME/.dotnet/tools:$PATH'
    } >> "$HOME_DIR/.bashrc"
  fi
  link_dotnet
}

ensure_docker() {
  if docker info >/dev/null 2>&1; then return 0; fi
  if ! command -v docker >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    log "installing Docker"
    (apt-get update -qq && apt-get install -y docker.io) >> "$LOG" 2>&1 || log "WARNING: installing Docker failed"
  fi
  mkdir -p "$DOCKER_DATA_ROOT"
  service docker stop >/dev/null 2>&1 || true
  (nohup dockerd --data-root "$DOCKER_DATA_ROOT" >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || {
    log "WARNING: Docker won't run here (see /tmp/dockerd.log)"
    return 1
  }
}

prep_sqlserver() {
  ensure_docker || return 1
  if docker image inspect "$MSSQL_IMAGE" >/dev/null 2>&1; then
    log "SQL Server image already cached"
    return 0
  fi
  log "pulling $MSSQL_IMAGE (~2.3 GB)"
  docker pull "$MSSQL_IMAGE" >> "$LOG" 2>&1 && log "SQL Server image cached" || log "WARNING: pulling the SQL Server image failed"
}

write_manifest() {
  local sdk db status
  if has_channel; then
    sdk="$(dotnet --version 2>/dev/null) (channel $CHANNEL)"
    status="ready"
  else
    sdk="**not installed** (channel $CHANNEL). \`dotnet build\`, \`dotnet test\`, and run-umbraco.sh will fail. Report build and test steps as blocked, not failed. The reason is in ~/loop-setup.log; the usual cause is the environment's allowed domains."
    status="NOT ready"
  fi
  db="SQLite only. Use \`--provider sqlite\`."
  if [ "$PROVIDER" = "sqlserver" ]; then
    if docker image inspect "$MSSQL_IMAGE" >/dev/null 2>&1; then
      db="SQL Server image cached. Prefer \`--provider sqlserver\` for tests, since it matches CI; run-umbraco.sh starts Docker and the container."
    else
      db="SQL Server was asked for, but its image **isn't cached**. Only \`--provider sqlite\` works."
    fi
  fi
  {
    echo
    echo "## Umbraco: $status"
    echo
    echo "| What | State |"
    echo "|---|---|"
    echo "| .NET SDK | $sdk |"
    echo "| Database | $db |"
    echo
    echo "Start a site from the repo checkout, with the repo's own start command:"
    echo
    echo '```'
    echo "bash ~/.loop/run-umbraco.sh --provider <sqlite|sqlserver> --boot \"dotnet run --project <Site.csproj> --no-launch-profile\""
    echo '```'
    echo
    echo "It waits until the site answers and prints its URL, or exits non-zero with the boot log."
  } >> "$MANIFEST"
}

log "===== umbraco stack setup (channel $CHANNEL, provider $PROVIDER) ====="
case "$PROVIDER" in
  sqlite | sqlserver) ;;
  *)
    log "WARNING: unknown provider \"$PROVIDER\"; using sqlite"
    PROVIDER=sqlite
    ;;
esac
mkdir -p "$SCRIPTS_DIR"
cp "$HERE/run-umbraco.sh" "$SCRIPTS_DIR/run-umbraco.sh" && chmod +x "$SCRIPTS_DIR/run-umbraco.sh"
install_dotnet
[ "$PROVIDER" = "sqlserver" ] && { prep_sqlserver || true; }
write_manifest
log "===== umbraco stack setup done ====="
exit 0
