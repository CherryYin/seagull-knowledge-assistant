# AGENTS.md

This file is the workspace profile and operating guide for Codex/agents working in this repository. Keep it current when project capabilities, architecture, tools, or workflows change.

## Project Overview

Seagull / Personal Knowledge Graph is a FastAPI + React personal knowledge platform. It turns raw materials such as Markdown notes, PDFs, documents, web pages, RSS articles, GitHub repositories, and arXiv papers into searchable sources, structured notes, wiki pages, reviews, discovery items, and publishable assets.

The core product goal is a durable personal knowledge graph with deterministic retrieval plus Harness-powered agent workflows.

## Core Capabilities

- Ingest and manage sources, notes, categories, files, and user-owned chat sessions; image and video files are first-class Sources stored in MinIO with SHA-256 deduplication and a user-reviewed searchable description.
- Generate image/video Source description proposals with the configured multimodal LLM; image proposals inspect a normalized image and video proposals inspect sampled representative frames, while saving remains an explicit user action. Media Source title, search description, and detailed Extraction Content remain user-editable, and description/extraction edits rebuild the Source search index.
- Treat `pdf` and `article` sources as permanent user knowledge: automated retention jobs must never delete them; deletion requires an explicit user action.
- Search knowledge using SQL filters, vector embeddings, full-text style search, and hybrid retrieval.
- Expose authenticated REST APIs that Harness tools use to search, read, and write user knowledge.
- Delegate interactive Agent Chat and workflow execution to DeepSeek Harness through the shared gateway.
- Persist a per-message Agent Run contract in Chat sessions so Workflow/Owner context, terminal status, allowed save actions, and saved receipts survive Workflow changes, reloads, and History review.
- Present Agent runs, Proposal actions, unsaved state, and recoverable errors through shared interaction components; user-facing copy explains impact and recovery while tool names, revisions, and raw contracts stay in diagnostic details.
- Import or discover external knowledge from RSS, web pages, GitHub repositories, arXiv papers, and news providers.
- Run recurring PKG automation through a single background Worker with PostgreSQL advisory locks, bounded task execution, short failed-run retries, startup-relative initial delays, and one batched job-history read per polling cycle.
- Treat `docs/plans/scheduled-pipeline/scheduling-policy.md` and `scheduler_policy.py` as the authority for which capabilities remain independent calendar jobs, due-item dispatchers, upstream-triggered derivations, or transitional automation.
- Create `web` sources from a direct URL by fetching and extracting readable page text when content is left empty.
- Discover article links from a `web` directory source such as a blog index and import each article as a child web source.
- Classify Web Sources as saved pages, RSS collections, directory collections, or collected articles through backward-compatible metadata; explicit user saves are terminal review decisions, while automatically collected articles enter imported review exactly once and content refreshes preserve prior decisions.
- Manage review suggestions, discovery items, wiki pages, summaries, and temporary/permanent knowledge artifacts while delegating interactive Wiki/Asset drafting to Harness workflows.
- Promote Wiki Drafts into the internal Stable knowledge layer through a readiness preview and explicit revision-safe confirmation; formal lifecycle fields are authoritative while legacy lifecycle tags remain synchronized for compatibility.
- Preserve terminal discovery decisions (`saved`, `kept`, and `dismissed`) as durable deduplication history so reviewed connector items are not recommended again.
- Keep Discovery focused on unsaved external Connector Search/Trend candidates; once RSS, Web, News, or other collected content exists as a Source, Source Review owns the decision and Discovery must not ask again. Use `/discovery/refresh` as the canonical refresh endpoint while retaining `/discovery/generate` only for compatibility.
- Create Assets through an Intent → Evidence → Claims → Draft workflow: selected records begin as reviewable Evidence candidates, and initial drafting stays locked until the current Evidence and Claim gates are complete.
- Preserve Asset evidence continuity: `Need More Evidence` creates a scoped request instead of a fake Source reference, resumes the original Evidence Agent session when available, and keeps Supports/Contradicts/Context/Unverified explicit. Independent questions may fork a new Asset with copied references but a fresh Workspace.
- Preserve unsaved Asset Editor changes with a deterministic saved/editor signature, tab-scoped recovery draft, refresh and navigation warnings, and save-time cleanup; query refreshes must not overwrite a dirty editor.
- Trace promoted or referenced Notes and Wiki pages back to their related Assets, including the originating Knowledge Candidate and Claim references when the record was distilled from an Asset.
- Generate PDF Source Mind Map proposals from bounded section/Chunk summaries in ephemeral Harness sessions, validate Source basis and references in PKG, and require explicit version-safe confirmation before creating or safely merging the formal Map.
- Project saved Asset Blocks into a revision-based Asset Outline Map with stable Block/Claim references; M3 is complete with deterministic projection, stale refresh, Patch Preview, revision-safe local Editor Apply, and existing Save Changes as the sole persistence path. Legacy or automatically generated Assets with saved text but no Block record expose an explicit Establish Stable Blocks action before projection. Agent outline refinement is optional M3.1 work.
- Create and edit newsletter assets through PKG CRUD, then develop their content in Harness Agent Chat and explicitly save the reviewed result back to the Asset.
- Run Newsletter automation only from a saved configuration revision: dirty UI settings must save before Run, each result carries a configuration snapshot, skipped runs are recorded, and generated Assets retain the revision used.
- Pin notes for quick access, keep content version history (snapshots captured on content/title edits, restorable), and attach inline images to notes via drag-and-drop upload.
- Link Calendar Todos to Notes before or after creation, return lightweight linked Note context without N+1 queries, and let Note Detail create or navigate its open Todos; deleting a Note clears the Todo link without deleting the Todo.
- Mine recent knowledge materials for reusable concept/entity candidates and recommend concept wiki drafts with evidence.
- Support persistent conversations, model/provider selection, observable background jobs, and user profiling.

## Key Architecture

- `src/pkg/api/`: FastAPI route modules.
- `src/pkg/services/`: business logic, integrations, retrieval, import pipelines, background jobs, and knowledge production services.
- `src/pkg/models/`: SQLAlchemy models.
- `src/pkg/schemas/`: Pydantic request/response schemas.
- `alembic/versions/`: database migrations.
- `tests/`: pytest coverage for APIs, services, and schemas.
- `web/src/pages/`: React application pages.
- `web/src/lib/api/`: frontend API clients.
- `web/src/lib/status.ts`, `web/src/components/StatusBadge.tsx`, `web/src/components/StateMessage.tsx`: user-facing status and empty/error state presentation helpers.
- `web/src/components/`: reusable UI components.
- `scripts/`: operational/backfill/import helper scripts.
- `docs/`: all project documentation. Do not add new top-level `architectures/` documents; organize docs under `docs/` by topic folder, such as `docs/architecture/<topic>/`, `docs/plans/<topic>/`, `docs/roadmaps/<topic>/`, and `docs/reference/<topic>/`. Within a topic folder, prefer stable filenames like `architecture.md`, `plan.md`, `implementation-plan.md`, `progress.md`, and `roadmap.md`.

## Planning Source of Truth

- Use `docs/plans/product-priorities/roadmap.md` for the current cross-product execution order outside the dedicated Mind Map roadmap.
- In active checklists, `[x]` means completed, `[ ]` means active pending work, and `[-]` means closed, superseded, or explicitly deferred.
- Do not report unchecked tasks from historical or ignored documents as current work without verifying the current Roadmap and implementation first.
- `docs/plans/agent-guided-knowledge-flow/implementation-plan.md` retains historical design context, but only its remaining `[ ]` items are active.
- `docs/plans/wiki-system/implementation-plan.md` is historical and partially superseded; the active Draft → Stable lifecycle work lives in the Product Priorities roadmap.
- Mind Map M4/M5 work remains governed by `docs/plans/mind-map/roadmap.md`; optional M3.1 work is not an active Exit Gate.

## Important Backend Areas

- `src/pkg/api/app.py`: FastAPI app setup, routers, logging, and background loops.
- `src/pkg/api/completion.py`: lightweight `/action/complete` direct-LLM completion stream used by Note AI; it has no Agent tools or Session persistence.
- `src/pkg/services/foundation/retriever.py`: Source/Chunk/Note/Wiki/Asset retrieval; it does not query a Memory Tree.
- `src/pkg/services/foundation/sync_pipeline.py`, `src/pkg/services/foundation/document_extractor.py`: source ingestion and document processing.
- `src/pkg/services/foundation/connectors.py`: GitHub, arXiv, and news connector search/import logic.
- `src/pkg/services/foundation/connector_trends.py`: scheduled GitHub-only trend collection dispatches explicit enabled daily/weekly `GitHubTrendProfile` records; the old mixed entry point remains a compatibility wrapper, while scholarly collection belongs to Paper Discovery.
- `src/pkg/services/foundation/rss_fetcher.py`, `src/pkg/services/foundation/rss_discovery.py`, `src/pkg/services/foundation/rss_summarizer.py`: RSS ingestion and summarization.
- `src/pkg/services/foundation/discovery.py`, `src/pkg/services/foundation/review_suggestions.py`, `src/pkg/services/foundation/wiki_recompile.py`: discovery/review/wiki workflows.
- `src/pkg/services/foundation/wiki_concept_discovery.py`: reusable knowledge concept/entity discovery for wiki mining recommendations, with rule-based recall and optional top-K LLM refinement.
- `src/pkg/services/cross_cutting/system_jobs.py` and `web/src/pages/SystemJobsPage.tsx`: background job observability, failure inspection, and troubleshooting entry points.
- System jobs are user-scoped when attached to a user; global jobs are for admin/system inspection and must not leak to ordinary users.
- `src/pkg/api/system.py`: authenticated system capability/status endpoint used by the frontend module settings UI to distinguish visible-by-preference from unavailable-by-setup modules.

## Agent Integration

- Interactive Agent Chat, workflow presets, tool execution, and runtime event history live in DeepSeek Harness.
- PKG owns users, knowledge assets, authentication, and `chat_sessions` ownership records.
- BFF validates PKG ownership and relays the current user's PKG token to Harness tools.
- Harness Web Search is provided by the project `pkg-web-search` plugin, which calls PKG's authenticated read-only `/discovery/web-search/preview` endpoint. It may use the user's Tavily credential but must not persist preview results automatically.
- PKG does not own Chat Agent model selection or Agent runtime defaults. Its user settings may own Publishing defaults and PKG-specific background model choices, while Harness owns Chat model catalogs, defaults, and per-session selection.
- PKG no longer registers `/action`, `/action/stream`, `/agent-profiles`, or `/agent-runs`.
- `/action/complete` remains available only for lightweight note-writing assistance.
- The legacy Memory Tree API, services, ORM models, and database schema have been removed. Do not reintroduce MemoryNode as an intermediate knowledge layer.
- The in-repo `web/` client is archived and must not receive new product work. The supported frontend is the sibling `seagull-ui` repository; legacy `/chat` links in `web/` are historical and must not be treated as active Agent entry points.

When changing gateway authentication, Harness tools, Session ownership, or completion streaming, update this file.

## External Connectors

- Direct web URL capture for `web` sources lives in `src/pkg/services/foundation/web_extractor.py` and is invoked by `src/pkg/api/sources.py` before persistence when `raw_content` is empty.
- Web directory article discovery lives in `src/pkg/services/foundation/web_directory.py` and uses `metadata.feed_source_id` to link imported child articles to the parent directory source.
- arXiv search/import lives in `src/pkg/services/foundation/connectors.py` and `src/pkg/api/connectors.py`.
- GitHub search/import lives in `src/pkg/services/foundation/connectors.py` and `src/pkg/api/connectors.py`.
- News search/import lives in `src/pkg/services/foundation/connectors.py` and `src/pkg/api/connectors.py`; imported news is stored as `article` sources with `metadata.kind = "news"`.
- Connector search results are cached temporarily before being kept as permanent sources.
- Default GitHub and arXiv search windows should stay aligned with product expectations; currently searches default to the past year unless callers provide explicit dates.
- arXiv may return `429`; code should preserve this as rate limiting rather than converting it to a generic bad gateway where possible.

## Development Commands

Use the project virtual environment when available.

- Install backend dev dependencies: `pip install -e ".[dev]"`
- Run backend tests: `.venv/bin/python -m pytest`
- Run targeted backend tests: `.venv/bin/python -m pytest tests/test_connectors.py`
- Type/syntax sanity for touched Python files: `python -m py_compile <files>`
- Apply migrations: `alembic upgrade head`
- Start infrastructure: `docker compose up -d`
- Start API: `pkg serve`; add `--reload` only for local development.
- Start scheduled jobs separately: `pkg worker`.
- Set strong `JWT_SECRET_KEY` and `ADMIN_INIT_PASSWORD`; weak or missing admin initialization password blocks normal app startup.
- Frontend dependencies/build commands are in `package.json`; inspect scripts before running.

## Coding Guidelines

- Keep changes focused and minimal; fix root causes rather than adding superficial workarounds.
- Follow existing FastAPI + SQLAlchemy async patterns.
- Keep API schemas in `src/pkg/schemas/` synchronized with route behavior and frontend clients.
- Add or update Alembic migrations when changing persisted models.
- Prefer service-layer defaults and shared helpers when behavior is used by API routes, scripts, and background jobs.
- Avoid broad exception swallowing. Preserve meaningful statuses such as authentication failures, validation errors, and external rate limits.
- Avoid unrelated cleanup in large dirty working trees; many files may already be modified or untracked.
- Do not commit changes unless explicitly asked.
- When creating or moving documentation, keep it under `docs/` in a topic-based subfolder rather than adding flat files at the repository root or under a separate `architectures/` tree.

## Testing Guidelines

- Run the narrowest relevant tests first, then broader tests if needed.
- For connector changes, run `.venv/bin/python -m pytest tests/test_connectors.py` when dependencies are installed.
- For API route changes, prefer targeted `tests/test_api_*.py` files.
- If `.venv` is unavailable or dependencies are missing, still run `python -m py_compile` on touched Python files and report the limitation.
- Do not fix unrelated failing tests unless explicitly requested.

## Maintenance Rule

Update this `AGENTS.md` whenever a change affects:

- User-facing product capabilities.
- Agent tools, skills, profile behavior, workspace profile injection, or streaming behavior.
- External connectors or background jobs.
- Persistent data models or migrations.
- Setup, test, run, or deployment assumptions.
- Major frontend routes or API client organization.
