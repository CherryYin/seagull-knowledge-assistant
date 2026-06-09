#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-/home/yj-linux/code/knowledge/personal_knowledge_foundation}"

printf 'Foundation repo: %s\n' "$REPO"
cd "$REPO"

python - <<'PY'
from pathlib import Path
import re

# -----------------------------
# 1) Frontend: strip paper/discovery path from SourcesPage
# -----------------------------
sources = Path('web/src/pages/SourcesPage.tsx')
if sources.exists():
    text = sources.read_text(encoding='utf-8')

    for s in [
        'import { PaperDetailDialog, type PaperDetailData } from "@/components/PaperDetailDialog";\n',
        'import { toPaperResult } from "@/lib/discovery-detail";\n',
        'import { discoveryApi, type DiscoveryItem } from "@/lib/api";\n',
        'import { paperDiscoveryApi } from "@/lib/api/paper-discovery";\n',
    ]:
        text = text.replace(s, '')

    for s in [
        '  const [paperDiscoveryItems, setPaperDiscoveryItems] = useState<DiscoveryItem[]>([]);\n',
        '  const [activePaper, setActivePaper] = useState<PaperDetailData | null>(null);\n',
    ]:
        text = text.replace(s, '')

    # Rename paper form/results back to arxiv-oriented simple naming when possible.
    text = text.replace('paperForm', 'arxivForm')
    text = text.replace('paperResults', 'arxivResults')
    text = text.replace('paperSearchMutation', 'arxivSearchMutation')
    text = text.replace('paperImportMutation', 'arxivImportMutation')

    # Remove discovery-integrated paper search/import blocks and fall back to connectors arXiv API.
    text = re.sub(
        r'const arxivSearchMutation = useMutation\([\s\S]*?\n\s*}\);\n\n\s*const arxivImportMutation = useMutation\([\s\S]*?\n\s*}\);',
        '''const arxivSearchMutation = useMutation({
    mutationFn: () => connectorsApi.searchArxiv({
      query: arxivForm.query || undefined,
      author: arxivForm.author || undefined,
      category: arxivForm.category || undefined,
      paper_id: arxivForm.paperId || undefined,
      max_results: arxivForm.maxResults,
    }),
    onSuccess: (result) => {
      setArxivResults(result.items);
      setConnectorMessage(`Found ${result.total} arXiv paper(s). Unsaved results are cached for 7 days.`);
    },
  });

  const arxivImportMutation = useMutation({
    mutationFn: (paper: ArxivPaper) => connectorsApi.importArxiv({ paper, category_id: arxivForm.categoryId }),
    onSuccess: (result, paper) => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["memory-nodes"] });
      setArxivResults((items) => items.map((item) => item.arxiv_id === paper.arxiv_id ? { ...item, cache_status: "saved", cache_expires_at: null, source_id: result.source.id } : item));
      setTypeFilter("article");
      setFeedView("parents");
      setConnectorMessage(`${result.created ? "Kept" : "Updated"} ${result.source.title}`);
    },
  });''',
        text,
        count=1,
    )

    # Remove any remaining PaperDetailDialog render.
    text = re.sub(r'\n\s*<PaperDetailDialog[\s\S]*?/>\n', '\n', text)

    sources.write_text(text, encoding='utf-8')

# -----------------------------
# 2) Frontend: remove System Jobs card from SettingsPage
# -----------------------------
settings = Path('web/src/pages/SettingsPage.tsx')
if settings.exists():
    text = settings.read_text(encoding='utf-8')
    text = re.sub(r'^.*System Jobs.*\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'^.*System Dashboard.*\n', '', text, flags=re.MULTILINE)
    settings.write_text(text, encoding='utf-8')

# -----------------------------
# 3) Frontend: redirect old wiki suggestion links to review suggestions
# -----------------------------
for page in [
    Path('web/src/pages/NoteDetailPage.tsx'),
    Path('web/src/pages/SourceDetailPage.tsx'),
    Path('web/src/pages/ReviewPage.tsx'),
    Path('web/src/pages/MemoryTreePage.tsx'),
    Path('web/src/pages/HomePage.tsx'),
]:
    if page.exists():
        text = page.read_text(encoding='utf-8')
        text = text.replace('/review/wiki-suggestions', '/review/suggestions')
        page.write_text(text, encoding='utf-8')

# -----------------------------
# 4) Backend: stop discovery side-effects in connectors and RSS fetcher
# -----------------------------
for path in [
    Path('src/pkg/api/connectors.py'),
    Path('src/pkg/services/rss_fetcher.py'),
]:
    if path.exists():
        text = path.read_text(encoding='utf-8')
        text = re.sub(r'^from pkg\.services\.discovery import generate_discovery_items\n', '', text, flags=re.MULTILINE)
        text = re.sub(r'\n\s*await generate_discovery_items\([\s\S]*?\)\n', '\n', text)
        text = re.sub(r'\n\s*logger\.error\("RSS discovery item generation failed.*?\n', '\n', text)
        path.write_text(text, encoding='utf-8')
PY

printf '\nSuggested next validation commands in the foundation repo:\n'
printf '  python -m py_compile src/pkg/api/app.py src/pkg/api/connectors.py src/pkg/services/rss_fetcher.py\n'
printf '  rg -n "discoveryApi|paperDiscoveryApi|PaperDetailDialog|/settings/jobs|/review/wiki-suggestions" web/src -g '!web/node_modules'\n'
printf '  rg -n "generate_discovery_items|from pkg\\.services\\.discovery" src/pkg/api/connectors.py src/pkg/services/rss_fetcher.py\n'
printf '  git diff -- web/src/pages/SourcesPage.tsx web/src/pages/SettingsPage.tsx web/src/pages/NoteDetailPage.tsx src/pkg/api/connectors.py src/pkg/services/rss_fetcher.py\n'
