#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_ROOT="$ROOT_DIR/personal_knowledge_graph"

[[ -x "$PKG_ROOT/.venv/bin/pytest" ]] || {
  printf 'PKG virtual environment is missing. Run ./scripts/bootstrap.sh first.\n' >&2
  exit 1
}

"$PKG_ROOT/.venv/bin/pytest" "$PKG_ROOT/tests" -q
if [[ -x "$PKG_ROOT/.venv/bin/ruff" ]]; then
  "$PKG_ROOT/.venv/bin/ruff" check "$PKG_ROOT/src" "$PKG_ROOT/tests"
fi

npm --prefix "$ROOT_DIR/bff" test
npm --prefix "$ROOT_DIR/seagull-ui" run build
npm --prefix "$ROOT_DIR/deepseek-knowledge-lab" run profiles:check
npm --prefix "$ROOT_DIR" run test:integration
