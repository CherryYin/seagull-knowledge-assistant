#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/tmp/dev"
PID_DIR="$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
FRONTEND_PID_FILE="$PID_DIR/frontend.pid"

mkdir -p "$LOG_DIR"

BACKEND_CMD=(pkg serve)
if [[ -x "$ROOT_DIR/.venv/bin/pkg" ]]; then
  BACKEND_CMD=("$ROOT_DIR/.venv/bin/pkg" serve)
fi

FRONTEND_CMD=(npm --prefix "$ROOT_DIR/web" run dev)

stop_if_running() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

stop_if_running "$BACKEND_PID_FILE"
stop_if_running "$FRONTEND_PID_FILE"

echo "Starting backend in background..."
(
  cd "$ROOT_DIR"
  exec "${BACKEND_CMD[@]}"
) >"$BACKEND_LOG" 2>&1 &
echo $! > "$BACKEND_PID_FILE"

echo "Starting frontend in background..."
(
  cd "$ROOT_DIR"
  exec "${FRONTEND_CMD[@]}"
) >"$FRONTEND_LOG" 2>&1 &
echo $! > "$FRONTEND_PID_FILE"

echo "Backend PID: $(cat "$BACKEND_PID_FILE")"
echo "Frontend PID: $(cat "$FRONTEND_PID_FILE")"
echo "Backend log: $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
