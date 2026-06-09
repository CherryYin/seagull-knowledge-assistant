#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-/home/yj-linux/code/knowledge/personal_knowledge_foundation}"

printf 'Foundation repo: %s\n' "$REPO"
cd "$REPO"

python - <<'PY'
from pathlib import Path

# -----------------------------
# 1) Simplify frontend nav and remove links to excluded areas
# -----------------------------
layout = Path('web/src/components/Layout.tsx')
if layout.exists():
    text = layout.read_text(encoding='utf-8')
    replacements = {
        '{ to: "/calendar", icon: CalendarDays, label: "Calendar" },\n': '',
        '{ to: "/completed", icon: CalendarCheck2, label: "Completed" },\n': '',
        '{ to: "/documents", icon: BookOpen, label: "Documents" },\n': '',
        '{ to: "/discover", icon: Compass, label: "Discover" },\n': '',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    layout.write_text(text, encoding='utf-8')

section_nav = Path('web/src/components/SectionNav.tsx')
if section_nav.exists():
    text = section_nav.read_text(encoding='utf-8')
    for s in [
        '\t{ label: "Documents", to: "/documents" },\n',
        '\t{ label: "Wiki Review", to: "/review/wiki-suggestions" },\n',
        '\t{ label: "Recommended", to: "/discover" },\n',
        '\t{ label: "Skills", to: "/settings/skills" },\n',
        '\t{ label: "Workspace", to: "/settings/workspace" },\n',
        '\t{ label: "Jobs", to: "/settings/jobs" },\n',
        '\t{ label: "Dashboard", to: "/stats" },\n',
    ]:
        text = text.replace(s, '')
    section_nav.write_text(text, encoding='utf-8')

# -----------------------------
# 2) Remove broken wiki suggestion navigation from pages
# -----------------------------
for page in [
    Path('web/src/pages/SourceDetailPage.tsx'),
    Path('web/src/pages/ReviewPage.tsx'),
    Path('web/src/pages/MemoryTreePage.tsx'),
]:
    if page.exists():
        text = page.read_text(encoding='utf-8')
        text = text.replace('/review/wiki-suggestions', '/review/suggestions')
        page.write_text(text, encoding='utf-8')

# -----------------------------
# 3) Remove discovery / paper hooks from SourcesPage
# -----------------------------
sources_page = Path('web/src/pages/SourcesPage.tsx')
if sources_page.exists():
    text = sources_page.read_text(encoding='utf-8')
    for s in [
        'import { toPaperResult } from "@/lib/discovery-detail";\n',
        'import { discoveryApi, type DiscoveryItem } from "@/lib/api";\n',
        'import { paperDiscoveryApi } from "@/lib/api/paper-discovery";\n',
        'import { PaperDetailDialog, type PaperDetailData } from "@/components/PaperDetailDialog";\n',
    ]:
        text = text.replace(s, '')

    # crude but effective first-pass: remove paper discovery state/hooks block by block
    snippets = [
        '  const [selectedPaper, setSelectedPaper] = useState<PaperDetailData | null>(null);\n',
        '  const [paperDialogOpen, setPaperDialogOpen] = useState(false);\n',
        '  const { data: paperDiscoveryData } = useQuery({\n    queryKey: ["paper-discovery-candidates"],\n    queryFn: () => paperDiscoveryApi.listCandidates(),\n  });\n',
        '  const paperDiscoveryItems = paperDiscoveryData?.items ?? [];\n',
    ]
    for s in snippets:
        text = text.replace(s, '')

    # replace dialog render if present
    text = text.replace('{selectedPaper && (\n        <PaperDetailDialog\n          open={paperDialogOpen}\n          onOpenChange={setPaperDialogOpen}\n          paper={selectedPaper}\n        />\n      )}', '')

    sources_page.write_text(text, encoding='utf-8')

# -----------------------------
# 4) Remove stale API clients/files that should not be referenced
# -----------------------------
for path in [
    Path('web/src/lib/api/discovery.ts'),
    Path('web/src/lib/discovery-detail.ts'),
    Path('web/src/components/DiscoveryDetailDialog.tsx'),
    Path('web/src/components/PaperDetailDialog.tsx'),
]:
    if path.exists():
        path.unlink()
PY

printf '\nSuggested validation commands in the foundation repo:\n'
printf '  python -m py_compile src/pkg/api/app.py\n'
printf '  git diff -- web/src/components/Layout.tsx web/src/components/SectionNav.tsx web/src/pages/SourceDetailPage.tsx web/src/pages/ReviewPage.tsx web/src/pages/MemoryTreePage.tsx web/src/pages/SourcesPage.tsx\n'
printf '  git status --short\n'
