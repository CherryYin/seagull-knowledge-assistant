#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-/home/yj-linux/code/knowledge/personal_knowledge_foundation}"

printf 'Foundation repo: %s\n' "$REPO"
cd "$REPO"

python - <<'PY'
from pathlib import Path
import re

# -----------------------------
# 1) Backend: strongly trim app.py runtime surface
# -----------------------------
app = Path('src/pkg/api/app.py')
if app.exists():
    text = app.read_text(encoding='utf-8')

    # Drop remaining excluded router imports.
    for s in [
        'from pkg.api.discovery import router as discovery_router\n',
        'from pkg.api.paper_discovery import router as paper_discovery_router\n',
        'from pkg.api.system_jobs import router as system_jobs_router\n',
    ]:
        text = text.replace(s, '')

    # Remove whole async loop function blocks for excluded background jobs.
    text = re.sub(
        r'\nasync def _discovery_generate_loop\(\):[\s\S]*?(?=\nasync def |\n@asynccontextmanager|\napp = FastAPI\()',
        '\n',
        text,
    )
    text = re.sub(
        r'\nasync def _paper_discovery_loop\(\):[\s\S]*?(?=\nasync def |\n@asynccontextmanager|\napp = FastAPI\()',
        '\n',
        text,
    )

    # Remove remaining task hooks and if/else shells.
    for s in [
        '        background_tasks.append(asyncio.create_task(_discovery_generate_loop()))\n',
        '        background_tasks.append(asyncio.create_task(_paper_discovery_loop()))\n',
        '    if settings.DISCOVERY_AUTO_GENERATE_ENABLED:\n    else:\n        logger.info("Discovery auto-generation disabled. Set DISCOVERY_AUTO_GENERATE_ENABLED=true to enable it.")\n',
        '    if settings.PAPER_DISCOVERY_AUTO_ENABLED:\n    else:\n        logger.info("Paper discovery auto-run disabled. Set PAPER_DISCOVERY_AUTO_ENABLED=true to enable it.")\n',
        'app.include_router(discovery_router, prefix="/discovery", tags=["discovery"])\n',
        'app.include_router(paper_discovery_router, prefix="/paper-discovery", tags=["paper-discovery"])\n',
        'app.include_router(system_jobs_router, prefix="/system/jobs", tags=["system-jobs"])\n',
    ]:
        text = text.replace(s, '')

    app.write_text(text, encoding='utf-8')

# -----------------------------
# 2) Frontend: remove excluded page imports/routes from App.tsx
# -----------------------------
app_tsx = Path('web/src/App.tsx')
if app_tsx.exists():
    text = app_tsx.read_text(encoding='utf-8')
    for s in [
        'const WikiSuggestionsPage = lazy(() => import("./pages/WikiSuggestionsPage").then((m) => ({ default: m.WikiSuggestionsPage })));\n',
        'const DiscoverPage = lazy(() => import("./pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage })));\n',
        'const SystemJobsPage = lazy(() => import("./pages/SystemJobsPage").then((m) => ({ default: m.SystemJobsPage })));\n',
    ]:
        text = text.replace(s, '')
    for s in [
        '            <Route path="/discover" element={<LazyPage><DiscoverPage /></LazyPage>} />\n',
        '            <Route path="/settings/jobs" element={<LazyPage><SystemJobsPage /></LazyPage>} />\n',
        '            <Route path="/review/wiki-suggestions" element={<LazyPage><WikiSuggestionsPage /></LazyPage>} />\n',
        '            <Route path="/wiki/suggestions" element={<Navigate to="/review/wiki-suggestions" replace />} />\n',
    ]:
        text = text.replace(s, '')
    app_tsx.write_text(text, encoding='utf-8')

# -----------------------------
# 3) Frontend: collapse HomePage to foundation-only cards
# -----------------------------
home = Path('web/src/pages/HomePage.tsx')
if home.exists():
    text = home.read_text(encoding='utf-8')

    # Remove excluded imports best-effort.
    for pattern in [
        r'^\s*discoveryApi,\n',
        r'^\s*systemJobsApi,\n',
        r'^\s*type DiscoveryItem,\n',
        r'^\s*type SystemJob,\n',
        r'^import .*Compass.*\n',
        r'^import .*AlertTriangle.*\n',
    ]:
        text = re.sub(pattern, '', text, flags=re.MULTILINE)

    # Remove common discovery/system-job query blocks.
    text = re.sub(r'\n\s*const \{ data: keptDiscoveries[\s\S]*?\n\s*\}\);\n', '\n', text)
    text = re.sub(r'\n\s*const \{ data: recommendedDiscoveries[\s\S]*?\n\s*\}\);\n', '\n', text)
    text = re.sub(r'\n\s*const \{ data: systemJobs[\s\S]*?\n\s*\}\);\n', '\n', text)

    # Remove discovery/system-jobs card pushes.
    text = re.sub(r'\n.*discover.*\n', '\n', text)
    text = re.sub(r'\n.*System Jobs.*\n', '\n', text)
    text = re.sub(r'\n.*settings/jobs.*\n', '\n', text)
    text = text.replace('/review/wiki-suggestions', '/review/suggestions')
    text = text.replace('/discover', '/sources')

    # Remove helper function that depends on DiscoveryItem.
    text = re.sub(r'\nfunction discoveryCard\([\s\S]*?\n}\n', '\n', text)

    home.write_text(text, encoding='utf-8')

# -----------------------------
# 4) Frontend: disable paper discovery path in SourcesPage by deleting file and stubbing simple fallback
# -----------------------------
sources = Path('web/src/pages/SourcesPage.tsx')
if sources.exists():
    text = sources.read_text(encoding='utf-8')
    # Strong fallback: if paper discovery markers remain, leave a comment marker and strip common imports/usages.
    for s in [
        'import { PaperDetailDialog, type PaperDetailData } from "@/components/PaperDetailDialog";\n',
        'import { toPaperResult } from "@/lib/discovery-detail";\n',
        'import { discoveryApi, type DiscoveryItem } from "@/lib/api";\n',
        'import { paperDiscoveryApi } from "@/lib/api/paper-discovery";\n',
    ]:
        text = text.replace(s, '')
    text = text.replace('const [paperDiscoveryItems, setPaperDiscoveryItems] = useState<DiscoveryItem[]>([]);', '')
    text = text.replace('const [activePaper, setActivePaper] = useState<PaperDetailData | null>(null);', '')
    text = re.sub(r'\n\s*<PaperDetailDialog[\s\S]*?/>\n', '\n', text)
    sources.write_text(text, encoding='utf-8')

# -----------------------------
# 5) Frontend: remove excluded files and exports
# -----------------------------
api_barrel = Path('web/src/lib/api.ts')
if api_barrel.exists():
    text = api_barrel.read_text(encoding='utf-8')
    for s in [
        'export * from "./api/discovery";\n',
        'export * from "./api/paper-discovery";\n',
        'export * from "./api/system-jobs";\n',
    ]:
        text = text.replace(s, '')
    api_barrel.write_text(text, encoding='utf-8')

for path in [
    Path('web/src/pages/DiscoverPage.tsx'),
    Path('web/src/pages/SystemJobsPage.tsx'),
    Path('web/src/pages/WikiSuggestionsPage.tsx'),
    Path('web/src/lib/api/discovery.ts'),
    Path('web/src/lib/api/paper-discovery.ts'),
    Path('web/src/lib/api/system-jobs.ts'),
    Path('web/src/lib/discovery-detail.ts'),
    Path('web/src/components/DiscoveryDetailDialog.tsx'),
    Path('web/src/components/PaperDetailDialog.tsx'),
]:
    if path.exists():
        path.unlink()
PY

printf '\nSuggested validation commands in the foundation repo:\n'
printf '  python -m py_compile src/pkg/api/app.py\n'
printf '  rg -n "paper_discovery|system_jobs|discovery|WikiSuggestionsPage|DiscoverPage|SystemJobsPage|paperDiscovery|discoveryApi|PaperDetailDialog" src/pkg web/src -g '!web/node_modules'\n'
printf '  git diff -- src/pkg/api/app.py web/src/App.tsx web/src/pages/HomePage.tsx web/src/pages/SourcesPage.tsx web/src/lib/api.ts\n'
printf '  git status --short\n'
