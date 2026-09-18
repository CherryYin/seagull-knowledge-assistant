#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${SEAGULL_UI_DIR:-$ROOT_DIR/../seagull-ui}"
LOG_DIR="$ROOT_DIR/tmp/dev"
PID_DIR="$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend.log"
WORKER_LOG="$LOG_DIR/worker.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
WORKER_PID_FILE="$PID_DIR/worker.pid"
FRONTEND_PID_FILE="$PID_DIR/frontend.pid"

mkdir -p "$LOG_DIR"

BACKEND_CMD=(pkg serve --host 127.0.0.1 --port 8000)
if [[ -x "$ROOT_DIR/.venv/bin/pkg" ]]; then
  BACKEND_CMD=("$ROOT_DIR/.venv/bin/pkg" serve --host 127.0.0.1 --port 8000)
fi

FRONTEND_CMD=(npm --prefix "$FRONTEND_DIR" run dev -- --host 127.0.0.1)
WORKER_CMD=(pkg worker)
if [[ -x "$ROOT_DIR/.venv/bin/pkg" ]]; then
  WORKER_CMD=("$ROOT_DIR/.venv/bin/pkg" worker)
fi

stop_if_running() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

stop_if_running "$BACKEND_PID_FILE"
stop_if_running "$WORKER_PID_FILE"
stop_if_running "$FRONTEND_PID_FILE"

echo "Starting backend in background..."
(
  cd "$ROOT_DIR"
  exec nohup setsid "${BACKEND_CMD[@]}" </dev/null
) >"$BACKEND_LOG" 2>&1 &
echo $! > "$BACKEND_PID_FILE"

echo "Starting worker in background..."
(
  cd "$ROOT_DIR"
  exec nohup setsid "${WORKER_CMD[@]}" </dev/null
) >"$WORKER_LOG" 2>&1 &
echo $! > "$WORKER_PID_FILE"

echo "Starting frontend in background..."
(
  cd "$ROOT_DIR"
  exec nohup setsid "${FRONTEND_CMD[@]}" </dev/null
) >"$FRONTEND_LOG" 2>&1 &
echo $! > "$FRONTEND_PID_FILE"

echo "Backend PID: $(cat "$BACKEND_PID_FILE")"
echo "Worker PID: $(cat "$WORKER_PID_FILE")"
echo "Frontend PID: $(cat "$FRONTEND_PID_FILE")"
echo "Backend log: $BACKEND_LOG"
echo "Worker log: $WORKER_LOG"
echo "Frontend log: $FRONTEND_LOG"
