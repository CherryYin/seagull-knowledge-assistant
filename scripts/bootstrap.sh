#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_ROOT="$ROOT_DIR/personal_knowledge_graph"
UI_ROOT="$ROOT_DIR/seagull-ui"
LAB_ROOT="$ROOT_DIR/deepseek-knowledge-lab"
GATEWAY_ROOT="$ROOT_DIR/bff"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_command git
require_command python3
require_command npm
require_command corepack

corepack enable
corepack prepare pnpm@11.7.0 --activate

git -C "$ROOT_DIR" submodule update --init --recursive

if [[ ! -x "$PKG_ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$PKG_ROOT/.venv"
fi
"$PKG_ROOT/.venv/bin/pip" install -e "$PKG_ROOT[dev]"

npm --prefix "$UI_ROOT" ci
npm --prefix "$LAB_ROOT" ci
npm --prefix "$GATEWAY_ROOT" install
npm --prefix "$LAB_ROOT" run profiles:install

printf 'Bootstrap complete. Configure each service .env file before starting.\n'
