#!/usr/bin/env bash

set -euo pipefail

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$LAB_ROOT/.." && pwd)"
PKG_ROOT="$WORKSPACE_ROOT/personal_knowledge_graph"
BFF_ROOT="$WORKSPACE_ROOT/bff"
SEAGULL_ROOT="$WORKSPACE_ROOT/seagull-ui"
RUN_ROOT="$LAB_ROOT/.dsh/run/dev-stack"
LOG_ROOT="$LAB_ROOT/.dsh/logs/dev-stack"

PKG_URL="${PKG_URL:-http://127.0.0.1:8000}"
HARNESS_URL="${HARNESS_URL:-http://127.0.0.1:3080}"
BFF_URL="${BFF_URL:-http://127.0.0.1:4000}"
SEAGULL_URL="${SEAGULL_URL:-http://127.0.0.1:5173}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-90}"

SERVICES=(pkg-api pkg-worker harness bff seagull)
STARTED_SERVICES=()

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-stack.sh <command> [options]

Commands:
  start [--skip-infra] [--skip-worker]  Start the complete local platform
  stop [--keep-infra]                   Stop managed services and optionally infrastructure
  restart [--skip-infra] [--skip-worker]
                                        Restart the complete local platform
  status                                Show process and infrastructure status
  logs [service|all]                    Follow logs (default: all)
  check                                 Validate directories, env files, and commands

Services: pkg-api, pkg-worker, harness, bff, seagull

Environment overrides:
  PKG_URL, HARNESS_URL, BFF_URL, SEAGULL_URL, START_TIMEOUT_SECONDS
EOF
}

log() {
  printf '[dev-stack] %s\n' "$*"
}

fail() {
  printf '[dev-stack] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_directory() {
  [[ -d "$1" ]] || fail "missing directory: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

pid_file() {
  printf '%s/%s.pid\n' "$RUN_ROOT" "$1"
}

log_file() {
  printf '%s/%s.log\n' "$LOG_ROOT" "$1"
}

read_pid() {
  local file
  file="$(pid_file "$1")"
  [[ -f "$file" ]] && cat "$file"
}

is_running() {
  local pid
  pid="$(read_pid "$1" || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

clean_stale_pid() {
  local service="$1"
  if ! is_running "$service"; then
    rm -f "$(pid_file "$service")"
  fi
}

wait_for_url() {
  local service="$1"
  local url="$2"
  local deadline=$((SECONDS + START_TIMEOUT_SECONDS))

  until curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; do
    if ! is_running "$service"; then
      log "$service exited before becoming ready; last log lines:"
      tail -n 30 "$(log_file "$service")" >&2 || true
      return 1
    fi
    if (( SECONDS >= deadline )); then
      log "$service did not become ready within ${START_TIMEOUT_SECONDS}s: $url"
      tail -n 30 "$(log_file "$service")" >&2 || true
      return 1
    fi
    sleep 0.5
  done
}

start_service() {
  local service="$1"
  local directory="$2"
  local health_url="$3"
  shift 3

  clean_stale_pid "$service"
  if is_running "$service"; then
    log "$service already running (PID $(read_pid "$service"))"
    return
  fi

  mkdir -p "$RUN_ROOT" "$LOG_ROOT"
  log "starting $service"
  (
    cd "$directory"
    exec setsid "$@"
  ) >>"$(log_file "$service")" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$(pid_file "$service")"
  STARTED_SERVICES+=("$service")

  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    log "$service failed to start; last log lines:"
    tail -n 30 "$(log_file "$service")" >&2 || true
    return 1
  fi

  if [[ -n "$health_url" ]]; then
    wait_for_url "$service" "$health_url"
  fi
  log "$service ready (PID $pid${health_url:+, $health_url})"
}

stop_service() {
  local service="$1"
  local pid
  pid="$(read_pid "$service" || true)"

  if [[ -z "$pid" ]]; then
    log "$service is not managed by this script"
    return
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    log "$service is not running (stale PID $pid)"
    rm -f "$(pid_file "$service")"
    return
  fi

  log "stopping $service (PID $pid)"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + 15))
  while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "$service did not stop gracefully; sending KILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$(pid_file "$service")"
}

rollback_started() {
  local index
  if ((${#STARTED_SERVICES[@]} == 0)); then
    return
  fi
  log "startup failed; stopping services started in this run"
  for ((index=${#STARTED_SERVICES[@]} - 1; index >= 0; index--)); do
    stop_service "${STARTED_SERVICES[$index]}"
  done
}

check_prerequisites() {
  require_command bash
  require_command curl
  require_command docker
  require_command npm
  require_command node
  require_command setsid
  docker compose version >/dev/null 2>&1 || fail "docker compose plugin is unavailable"

  require_directory "$PKG_ROOT"
  require_directory "$BFF_ROOT"
  require_directory "$SEAGULL_ROOT"
  require_file "$PKG_ROOT/.env"
  require_file "$LAB_ROOT/.dsh/.env"
  require_file "$BFF_ROOT/.env"
  require_file "$SEAGULL_ROOT/.env"
  require_file "$BFF_ROOT/src/index.js"
  require_file "$SEAGULL_ROOT/package.json"
  require_file "$LAB_ROOT/dsh-harness/apps/cli/lib/bin.js"

  [[ -x "$PKG_ROOT/.venv/bin/pkg" ]] || fail "missing PKG virtualenv executable: $PKG_ROOT/.venv/bin/pkg"
  [[ -d "$LAB_ROOT/node_modules" ]] || fail "Lab dependencies are not installed; run npm install"
  [[ -d "$LAB_ROOT/.dsh/profiles/web/node_modules" ]] || fail "Harness web profile dependencies are not installed; run npm run profiles:install"
  [[ -d "$SEAGULL_ROOT/node_modules" ]] || fail "Seagull dependencies are not installed"

  log "prerequisites OK"
}

start_infrastructure() {
  log "starting PostgreSQL and MinIO"
  docker compose --project-directory "$PKG_ROOT" up -d
  log "infrastructure started"
}

stop_infrastructure() {
  log "stopping PostgreSQL and MinIO"
  docker compose --project-directory "$PKG_ROOT" stop
}

start_stack() {
  local skip_infra=false
  local skip_worker=false
  while (($#)); do
    case "$1" in
      --skip-infra) skip_infra=true ;;
      --skip-worker) skip_worker=true ;;
      *) fail "unknown start option: $1" ;;
    esac
    shift
  done

  check_prerequisites
  mkdir -p "$RUN_ROOT" "$LOG_ROOT"
  trap rollback_started ERR INT TERM

  if [[ "$skip_infra" == false ]]; then
    start_infrastructure
  fi

  start_service pkg-api "$PKG_ROOT" "$PKG_URL/health" \
    "$PKG_ROOT/.venv/bin/pkg" serve --host 127.0.0.1 --port 8000

  if [[ "$skip_worker" == false ]]; then
    start_service pkg-worker "$PKG_ROOT" "" \
      "$PKG_ROOT/.venv/bin/pkg" worker --poll-interval 30
  fi

  start_service harness "$LAB_ROOT" "$HARNESS_URL/" npm run run-web

  start_service bff "$BFF_ROOT" "$BFF_URL/api/health" \
    bash -c 'set -a; source "$1"; source "$2"; set +a; exec npm run start' \
    dev-stack "$BFF_ROOT/.env" "$LAB_ROOT/.dsh/.env"

  start_service seagull "$SEAGULL_ROOT" "$SEAGULL_URL/" \
    npm run dev -- --host 127.0.0.1

  trap - ERR INT TERM
  log "platform ready"
  printf '  Seagull: %s\n  Harness: %s\n  BFF:     %s\n  PKG:     %s\n' \
    "$SEAGULL_URL" "$HARNESS_URL" "$BFF_URL" "$PKG_URL"
  log "use './scripts/dev-stack.sh logs' to follow logs"
  log "use './scripts/dev-stack.sh stop' to stop everything"
}

stop_stack() {
  local keep_infra=false
  while (($#)); do
    case "$1" in
      --keep-infra) keep_infra=true ;;
      *) fail "unknown stop option: $1" ;;
    esac
    shift
  done

  local index
  for ((index=${#SERVICES[@]} - 1; index >= 0; index--)); do
    stop_service "${SERVICES[$index]}"
  done
  if [[ "$keep_infra" == false ]]; then
    stop_infrastructure
  fi
}

show_status() {
  local service pid state
  printf '%-14s %-10s %s\n' SERVICE STATUS PID
  for service in "${SERVICES[@]}"; do
    pid="$(read_pid "$service" || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      state=running
    elif [[ -n "$pid" ]]; then
      state=stale
    else
      state=stopped
    fi
    printf '%-14s %-10s %s\n' "$service" "$state" "${pid:--}"
  done
  printf '\nInfrastructure:\n'
  docker compose --project-directory "$PKG_ROOT" ps 2>/dev/null || true
}

follow_logs() {
  local target="${1:-all}"
  mkdir -p "$LOG_ROOT"
  if [[ "$target" == all ]]; then
    local files=()
    local service
    for service in "${SERVICES[@]}"; do
      [[ -f "$(log_file "$service")" ]] && files+=("$(log_file "$service")")
    done
    ((${#files[@]} > 0)) || fail "no service logs found in $LOG_ROOT"
    exec tail -n 100 -F "${files[@]}"
  fi

  case " $SERVICES " in
    *" $target "*) ;;
    *) fail "unknown service: $target" ;;
  esac
  require_file "$(log_file "$target")"
  exec tail -n 100 -F "$(log_file "$target")"
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 1
fi
shift

case "$command" in
  start) start_stack "$@" ;;
  stop) stop_stack "$@" ;;
  restart)
    stop_stack --keep-infra
    start_stack "$@"
    ;;
  status) show_status ;;
  logs) follow_logs "$@" ;;
  check) check_prerequisites ;;
  help|-h|--help) usage ;;
  *) usage; fail "unknown command: $command" ;;
esac
