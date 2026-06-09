#!/usr/bin/env bash
set -euo pipefail

SRC_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
DST_DEFAULT="$(cd "$SRC_DEFAULT/.." && pwd)/personal_knowledge_foundation"
SRC="${1:-$SRC_DEFAULT}"
DST="${2:-$DST_DEFAULT}"

printf 'Source: %s\n' "$SRC"
printf 'Target: %s\n' "$DST"

mkdir -p "$DST"

rsync -a --delete \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude 'web/node_modules' \
  --exclude '.pytest_cache' \
  --exclude '.ruff_cache' \
  --exclude 'data' \
  --exclude '.env' \
  "$SRC/" "$DST/"

cd "$DST"

rm -f src/pkg/api/paper_discovery.py || true
rm -f src/pkg/models/paper_discovery.py || true
rm -f src/pkg/models/paper_discovery_seen.py || true
rm -f src/pkg/schemas/paper_discovery.py || true
rm -f src/pkg/services/paper_discovery.py || true
rm -f src/pkg/services/paper_discovery_jobs.py || true
rm -f src/pkg/services/paper_discovery_seen.py || true
rm -f src/pkg/services/paper_query_builder.py || true
rm -f src/pkg/services/paper_trends.py || true
rm -rf src/pkg/services/paper_providers || true
rm -f tests/test_api_paper_discovery.py || true
rm -f tests/test_paper_discovery.py || true
rm -f tests/test_paper_discovery_jobs.py || true
rm -f tests/test_paper_providers_openalex.py || true
rm -f tests/test_paper_providers_semantic_scholar.py || true
rm -f tests/test_paper_query_builder.py || true
rm -f tests/test_paper_trends.py || true
rm -f web/src/lib/api/paper-discovery.ts || true
rm -f web/src/components/PaperDetailDialog.tsx || true

rm -f web/src/pages/WritingPage.tsx || true

rm -f docs/plans/knowledge-asset-commercialization/stage-1-plan.md || true
rm -f docs/plans/knowledge-asset-commercialization/implementation-tasks.md || true
rm -f docs/plans/knowledge-asset-commercialization/implementation-plan.md || true

rm -rf src/pkg/models/application src/pkg/schemas/application src/pkg/services/application || true

if [ ! -d .git ]; then
  git init
fi

printf '\nFoundation repo scaffold created at %s\n' "$DST"
printf 'Next steps:\n'
printf '  1) cd %s\n' "$DST"
printf '  2) review docs/plans/knowledge-layering/foundation-repo-copy-checklist.md\n'
printf '  3) prune extra routes/imports and run backend/frontend startup checks\n'
