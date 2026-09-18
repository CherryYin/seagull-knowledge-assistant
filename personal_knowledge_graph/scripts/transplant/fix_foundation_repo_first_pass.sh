#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-/home/yj-linux/code/knowledge/personal_knowledge_foundation}"

printf 'Foundation repo: %s\n' "$REPO"
cd "$REPO"

python - <<'PY'
from pathlib import Path

# -----------------------------
# Backend app.py first-pass cleanup
# -----------------------------
app = Path('src/pkg/api/app.py')
text = app.read_text(encoding='utf-8')

for s in [
    'from pkg.api.calendar_reminders import router as calendar_reminders_router\n',
    'from pkg.api.discovery import router as discovery_router\n',
    'from pkg.api.paper_discovery import router as paper_discovery_router\n',
    'from pkg.api.system_jobs import router as system_jobs_router\n',
]:
    text = text.replace(s, '')

text = text.replace('        background_tasks.append(asyncio.create_task(_paper_discovery_loop()))\n', '')
text = text.replace(
    '    if settings.PAPER_DISCOVERY_AUTO_ENABLED:\n'
    '    else:\n'
    '        logger.info("Paper discovery auto-run disabled. Set PAPER_DISCOVERY_AUTO_ENABLED=true to enable it.")\n',
    ''
)

for s in [
    'app.include_router(calendar_reminders_router, prefix="/calendar/reminders", tags=["calendar"])\n',
    'app.include_router(discovery_router, prefix="/discovery", tags=["discovery"])\n',
    'app.include_router(paper_discovery_router, prefix="/paper-discovery", tags=["paper-discovery"])\n',
    'app.include_router(system_jobs_router, prefix="/system/jobs", tags=["system-jobs"])\n',
]:
    text = text.replace(s, '')

app.write_text(text, encoding='utf-8')

# -----------------------------
# Frontend App.tsx first-pass cleanup
# -----------------------------
app_tsx = Path('web/src/App.tsx')
text = app_tsx.read_text(encoding='utf-8')

for s in [
    'const SkillsPage = lazy(() => import("./pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));\n',
    'const StatsPage = lazy(() => import("./pages/StatsPage").then((m) => ({ default: m.StatsPage })));\n',
    'const CalendarPage = lazy(() => import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })));\n',
    'const CompletedTodosPage = lazy(() => import("./pages/CompletedTodosPage").then((m) => ({ default: m.CompletedTodosPage })));\n',
    'const WritingPage = lazy(() => import("./pages/WritingPage").then((m) => ({ default: m.WritingPage })));\n',
    'const WikiSuggestionsPage = lazy(() => import("./pages/WikiSuggestionsPage").then((m) => ({ default: m.WikiSuggestionsPage })));\n',
    'const AdminUsersPage = lazy(() => import("./pages/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })));\n',
    'const DiscoverPage = lazy(() => import("./pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage })));\n',
    'const SystemJobsPage = lazy(() => import("./pages/SystemJobsPage").then((m) => ({ default: m.SystemJobsPage })));\n',
]:
    text = text.replace(s, '')

for s in [
    '            <Route path="/calendar" element={<LazyPage><CalendarPage /></LazyPage>} />\n',
    '            <Route path="/completed" element={<LazyPage><CompletedTodosPage /></LazyPage>} />\n',
    '            <Route path="/completed-todos" element={<Navigate to="/completed" replace />} />\n',
    '            <Route path="/discover" element={<LazyPage><DiscoverPage /></LazyPage>} />\n',
    '            <Route path="/settings/skills" element={<LazyPage><SkillsPage /></LazyPage>} />\n',
    '            <Route path="/settings/workspace" element={<LazyPage><AgentWorkspacePage /></LazyPage>} />\n',
    '            <Route path="/settings/jobs" element={<LazyPage><SystemJobsPage /></LazyPage>} />\n',
    '            <Route path="/skills" element={<Navigate to="/settings/skills" replace />} />\n',
    '            <Route path="/workspace" element={<Navigate to="/settings/workspace" replace />} />\n',
    '            <Route path="/documents" element={<LazyPage><WritingPage /></LazyPage>} />\n',
    '            <Route path="/review/wiki-suggestions" element={<LazyPage><WikiSuggestionsPage /></LazyPage>} />\n',
    '            <Route path="/wiki/writing" element={<Navigate to="/documents" replace />} />\n',
    '            <Route path="/wiki/suggestions" element={<Navigate to="/review/wiki-suggestions" replace />} />\n',
    '            <Route path="/writing" element={<Navigate to="/documents" replace />} />\n',
    '            <Route path="/stats" element={<LazyPage><StatsPage /></LazyPage>} />\n',
    '            <Route path="/admin/users" element={<AdminRoute><LazyPage><AdminUsersPage /></LazyPage></AdminRoute>} />\n',
]:
    text = text.replace(s, '')

app_tsx.write_text(text, encoding='utf-8')
PY

printf '\nRunning minimal validation...\n'
python -m py_compile src/pkg/api/app.py || true

printf '\nDone. Review these files next:\n'
printf '  - %s\n' "$REPO/src/pkg/api/app.py"
printf '  - %s\n' "$REPO/web/src/App.tsx"
printf '\nRecommended next commands:\n'
printf '  - git -C %s diff -- src/pkg/api/app.py web/src/App.tsx\n' "$REPO"
printf '  - git -C %s status --short\n' "$REPO"
