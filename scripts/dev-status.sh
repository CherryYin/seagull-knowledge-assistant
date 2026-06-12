#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT_DIR/tmp/dev"
BACKEND_PID_FILE="$DEV_DIR/backend.pid"
FRONTEND_PID_FILE="$DEV_DIR/frontend.pid"
BACKEND_LOG="$DEV_DIR/backend.log"
FRONTEND_LOG="$DEV_DIR/frontend.log"

show_status() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"

  echo "[$name]"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "status: running"
      echo "pid: $pid"
    else
      echo "status: stale pid file"
      echo "pid: ${pid:-unknown}"
    fi
  else
    echo "status: stopped"
  fi

  if [[ -f "$log_file" ]]; then
    echo "log: $log_file"
    echo "recent logs:"
    tail -n 10 "$log_file"
  else
    echo "log: missing"
  fi
  echo
}

show_status "backend" "$BACKEND_PID_FILE" "$BACKEND_LOG"
show_status "frontend" "$FRONTEND_PID_FILE" "$FRONTEND_LOG"
