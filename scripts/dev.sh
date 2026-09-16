#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${SEAGULL_UI_DIR:-$ROOT_DIR/../seagull-ui}"
BACKEND_CMD=(pkg serve --host 127.0.0.1 --port 8000)
WORKER_CMD=(pkg worker)
FRONTEND_CMD=(npm --prefix "$FRONTEND_DIR" run dev -- --host 127.0.0.1)

if [[ -x "$ROOT_DIR/.venv/bin/pkg" ]]; then
  BACKEND_CMD=("$ROOT_DIR/.venv/bin/pkg" serve --host 127.0.0.1 --port 8000)
  WORKER_CMD=("$ROOT_DIR/.venv/bin/pkg" worker)
fi

cleanup() {
  local exit_code=${1:-0}
  trap - INT TERM EXIT
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${WORKER_PID:-}" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  exit "$exit_code"
}

trap 'cleanup 0' INT TERM EXIT

echo "Starting backend: ${BACKEND_CMD[*]}"
(
  cd "$ROOT_DIR"
  "${BACKEND_CMD[@]}"
) &
BACKEND_PID=$!

echo "Starting worker: ${WORKER_CMD[*]}"
(
  cd "$ROOT_DIR"
  "${WORKER_CMD[@]}"
) &
WORKER_PID=$!

echo "Starting frontend: ${FRONTEND_CMD[*]}"
(
  cd "$ROOT_DIR"
  "${FRONTEND_CMD[@]}"
) &
FRONTEND_PID=$!

wait -n "$BACKEND_PID" "$WORKER_PID" "$FRONTEND_PID"
status=$?
echo "A dev process exited with status $status, stopping the other one..."
cleanup "$status"
