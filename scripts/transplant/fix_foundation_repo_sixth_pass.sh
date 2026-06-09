#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-/home/yj-linux/code/knowledge/personal_knowledge_foundation}"

printf 'Foundation repo: %s\n' "$REPO"
cd "$REPO"

python - <<'PY'
from pathlib import Path
import re

# -----------------------------
# 1) App.tsx: remove AgentWorkspacePage route/import/redirect
# -----------------------------
app_tsx = Path('web/src/App.tsx')
if app_tsx.exists():
    text = app_tsx.read_text(encoding='utf-8')
    text = re.sub(
        r'^const AgentWorkspacePage = lazy\(\(\) => import\("\.\/pages\/AgentWorkspacePage"\)\.then\(\(m\) => \(\{ default: m\.AgentWorkspacePage \}\)\)\);\n',
        '',
        text,
        flags=re.MULTILINE,
    )
    text = re.sub(r'^\s*<Route path="/settings/workspace".*\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*<Route path="/workspace".*\n', '', text, flags=re.MULTILINE)
    app_tsx.write_text(text, encoding='utf-8')

# -----------------------------
# 2) SettingsPage: remove Agent Workspace entry
# -----------------------------
settings = Path('web/src/pages/SettingsPage.tsx')
if settings.exists():
    text = settings.read_text(encoding='utf-8')
    text = re.sub(r'^.*Agent Workspace.*\n', '', text, flags=re.MULTILINE)
    settings.write_text(text, encoding='utf-8')

# -----------------------------
# 3) HomePage: remove systemJobsApi and related queries/cards
# -----------------------------
home = Path('web/src/pages/HomePage.tsx')
if home.exists():
    text = home.read_text(encoding='utf-8')

    # Remove direct systemJobsApi import fragments.
    text = re.sub(r'^\s*systemJobsApi,\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*type SystemJob,\n', '', text, flags=re.MULTILINE)

    # Remove likely job queries.
    text = re.sub(r'\n\s*const \{ data: failedJobs[\s\S]*?\n\s*\}\);\n', '\n', text)
    text = re.sub(r'\n\s*const \{ data: pendingJobs[\s\S]*?\n\s*\}\);\n', '\n', text)

    # Remove system-jobs card helper if still present.
    text = re.sub(r'\nfunction systemJobCard\([\s\S]*?\n}\n', '\n', text)

    # Remove lines that explicitly reference failed/pending jobs or system jobs routes.
    text = re.sub(r'^.*failedJobs.*\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'^.*pendingJobs.*\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'^.*System Jobs.*\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'^.*settings/jobs.*\n', '', text, flags=re.MULTILINE)

    home.write_text(text, encoding='utf-8')

# -----------------------------
# 4) Remove AgentWorkspacePage file
# -----------------------------
page = Path('web/src/pages/AgentWorkspacePage.tsx')
if page.exists():
    page.unlink()
PY

printf '\nSuggested next validation commands in the foundation repo:\n'
printf '  rg -n "systemJobsApi|/settings/workspace|/settings/jobs|AgentWorkspacePage" web/src -g '!web/node_modules'\n'
printf '  rg -n "AgentWorkspacePage" web/src/App.tsx web/src/pages/SettingsPage.tsx web/src/pages/HomePage.tsx -g '!web/node_modules'\n'
printf '  git diff -- web/src/App.tsx web/src/pages/SettingsPage.tsx web/src/pages/HomePage.tsx\n'
