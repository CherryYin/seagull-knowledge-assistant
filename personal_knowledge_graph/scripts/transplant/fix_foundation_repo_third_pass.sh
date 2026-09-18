#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-/home/yj-linux/code/knowledge/personal_knowledge_foundation}"

printf 'Foundation repo: %s\n' "$REPO"
cd "$REPO"

python - <<'PY'
from pathlib import Path
import re

# -----------------------------
# 1) Backend: remove remaining discovery/system-job loops from app.py
# -----------------------------
app = Path('src/pkg/api/app.py')
if app.exists():
    text = app.read_text(encoding='utf-8')

    # Remove discovery background task hook and empty if/else block if present.
    text = text.replace('        background_tasks.append(asyncio.create_task(_discovery_generate_loop()))\n', '')
    text = text.replace(
        '    if settings.DISCOVERY_AUTO_GENERATE_ENABLED:\n'
        '    else:\n'
        '        logger.info("Discovery auto-generation disabled. Set DISCOVERY_AUTO_GENERATE_ENABLED=true to enable it.")\n',
        ''
    )

    app.write_text(text, encoding='utf-8')

# -----------------------------
# 2) Frontend: simplify HomePage away from discovery/jobs/wiki-suggestion cards
# -----------------------------
home = Path('web/src/pages/HomePage.tsx')
if home.exists():
    text = home.read_text(encoding='utf-8')

    # Remove problematic imports (best-effort line deletions).
    for pattern in [
        r'^\s*discoveryApi,\n',
        r'^\s*systemJobsApi,\n',
        r'^\s*type DiscoveryItem,\n',
        r'^\s*type SystemJob,\n',
    ]:
        text = re.sub(pattern, '', text, flags=re.MULTILINE)

    # Remove direct links to excluded modules.
    text = text.replace('/review/wiki-suggestions', '/review/suggestions')
    text = text.replace('/discover', '/sources')
    text = text.replace('/settings/jobs', '/review')

    # Light content relabel for removed areas.
    text = text.replace('Open Discover', 'Open Sources')
    text = text.replace('Discover', 'Sources')
    text = text.replace('Open System Jobs', 'Open Review')
    text = text.replace('System Jobs', 'Review')
    text = text.replace('Open Wiki Refresh Queue', 'Open Review Suggestions')

    home.write_text(text, encoding='utf-8')

# -----------------------------
# 3) Frontend: aggressively strip paper discovery helpers from SourcesPage
# -----------------------------
sources = Path('web/src/pages/SourcesPage.tsx')
if sources.exists():
    text = sources.read_text(encoding='utf-8')

    # Imports
    for s in [
        'import { toPaperResult } from "@/lib/discovery-detail";\n',
        'import { discoveryApi, type DiscoveryItem } from "@/lib/api";\n',
        'import { paperDiscoveryApi } from "@/lib/api/paper-discovery";\n',
        'import { PaperDetailDialog, type PaperDetailData } from "@/components/PaperDetailDialog";\n',
    ]:
        text = text.replace(s, '')

    # Remove obvious paper-specific state lines.
    for s in [
        '  const [paperDiscoveryItems, setPaperDiscoveryItems] = useState<DiscoveryItem[]>([]);\n',
        '  const [activePaper, setActivePaper] = useState<PaperDetailData | null>(null);\n',
    ]:
        text = text.replace(s, '')

    # Remove common paper dialog render.
    text = re.sub(r'\n\s*<PaperDetailDialog[\s\S]*?/>\n', '\n', text)

    # If paper helper button labels remain, retarget to normal source flow wording.
    text = text.replace('Search papers', 'Search sources')
    text = text.replace('Paper search', 'Source search')

    sources.write_text(text, encoding='utf-8')

# -----------------------------
# 4) Remove stale frontend files if still present
# -----------------------------
for path in [
    Path('web/src/pages/DiscoverPage.tsx'),
    Path('web/src/pages/SystemJobsPage.tsx'),
    Path('web/src/pages/WikiSuggestionsPage.tsx'),
    Path('web/src/pages/CalendarPage.tsx'),
    Path('web/src/pages/CompletedTodosPage.tsx'),
    Path('web/src/pages/StatsPage.tsx'),
    Path('web/src/lib/api/paper-discovery.ts'),
]:
    if path.exists():
        path.unlink()
PY

printf '\nSuggested next validation commands in the foundation repo:\n'
printf '  python -m py_compile src/pkg/api/app.py\n'
printf '  rg -n "paper_discovery|system_jobs|discovery|WikiSuggestionsPage|DiscoverPage|SystemJobsPage|paperDiscovery|discoveryApi|PaperDetailDialog" src/pkg web/src -g '!web/node_modules'\n'
printf '  git status --short\n'
