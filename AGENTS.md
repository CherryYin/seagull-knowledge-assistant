# AGENTS.md

This file is the workspace profile and operating guide for Codex/agents working in this repository. Keep it current when project capabilities, architecture, tools, or workflows change.

## Project Overview

Seagull / Personal Knowledge Graph is a FastAPI + React personal knowledge mining system. It turns raw materials such as Markdown notes, PDFs, documents, web pages, RSS articles, GitHub repositories, and arXiv papers into searchable sources, structured notes, memory nodes, wiki pages, reviews, discovery items, and agent conversations.

The core product goal is a durable personal knowledge graph with deterministic retrieval plus LLM-powered agent workflows.

## Core Capabilities

- Ingest and manage sources, notes, categories, files, chat sessions, and agent profiles.
- Search knowledge using SQL filters, vector embeddings, full-text style search, and hybrid retrieval.
- Run a Strands-based Action Agent that can use project tools to search/read/write knowledge.
- Offer frontend Agent workflow templates for common tasks such as source summarization, recent import organization, topic research, and wiki refresh drafting.
- Inject this workspace profile into the default in-app Action Agent prompt when `AGENT_LOAD_WORKSPACE_PROFILE=true`.
- Import or discover external knowledge from RSS, web pages, GitHub repositories, and arXiv papers.
- Maintain memory nodes and memory edges for topic organization and semantic retrieval.
- Generate review suggestions, discovery items, wiki pages, summaries, and temporary/permanent knowledge artifacts.
- Support persistent conversations, model/provider selection, skills, background jobs, and user profiling.

## Key Architecture

- `src/pkg/api/`: FastAPI route modules.
- `src/pkg/services/`: business logic, integrations, agent tools, retrieval, import pipelines, background jobs.
- `src/pkg/models/`: SQLAlchemy models.
- `src/pkg/schemas/`: Pydantic request/response schemas.
- `alembic/versions/`: database migrations.
- `tests/`: pytest coverage for APIs, services, schemas, and agent-related behavior.
- `web/src/pages/`: React application pages.
- `web/src/lib/api/`: frontend API clients.
- `web/src/lib/agent-workflows.ts`: frontend-only Agent workflow catalog and prompt rendering helpers.
- `web/src/components/`: reusable UI components.
- `scripts/`: operational/backfill/import helper scripts.
- `skills/`: reusable prompt/workflow skills loaded by the app.

## Important Backend Areas

- `src/pkg/api/app.py`: FastAPI app setup, routers, logging, and background loops.
- `src/pkg/api/action.py`: streaming Action Agent endpoint and session persistence.
- `src/pkg/services/action_agent.py`: Strands Agent construction, tool wiring, and workspace profile prompt injection.
- `src/pkg/services/tools.py`, `src/pkg/services/tools_web.py`, `src/pkg/services/tools_document.py`: built-in agent tools.
- `src/pkg/services/retriever.py`, `src/pkg/services/memory_retriever.py`: knowledge and memory retrieval.
- `src/pkg/services/sync_pipeline.py`, `src/pkg/services/document_extractor.py`: source ingestion and document processing.
- `src/pkg/services/connectors.py`: GitHub and arXiv connector search/import logic.
- `src/pkg/services/connector_trends.py`: daily GitHub/arXiv trend collection.
- `src/pkg/services/rss_fetcher.py`, `src/pkg/services/rss_discovery.py`, `src/pkg/services/rss_summarizer.py`: RSS ingestion and summarization.
- `src/pkg/services/discovery.py`, `src/pkg/services/review_suggestions.py`, `src/pkg/services/wiki_recompile.py`: discovery/review/wiki workflows.

## Agent Capabilities In This Project

The in-app Action Agent loads this workspace profile into its system prompt by default, then can, depending on configured tools/profile/skills:

- Search the knowledge base and memory tree.
- Read notes, sources, and memory nodes.
- Create memory from conversations.
- Process documents and generate downloadable outputs.
- Search the web via configured web-search providers.
- Use project skills as reusable task instructions.
- Work with persisted chat sessions and agent run event logs.
- Start fixed prompt workflows from the Agent page or from Source, Note, and Discover context handoffs; workflows generate editable prompts and never auto-write durable state.

When changing tool names, tool behavior, workflow templates, skill loading, streaming behavior, or agent profile semantics, update this file.

## External Connectors

- arXiv search/import lives in `src/pkg/services/connectors.py` and `src/pkg/api/connectors.py`.
- GitHub search/import lives in `src/pkg/services/connectors.py` and `src/pkg/api/connectors.py`.
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
- Start API: `pkg serve` or the project-specific documented command.
- Disable workspace profile injection: set `AGENT_LOAD_WORKSPACE_PROFILE=false`.
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
