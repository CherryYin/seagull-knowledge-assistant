# Personal Knowledge Graph

[中文](README.md) | [English](README.en.md)

A three-layer personal knowledge mining system that turns Markdown notes and raw source materials into a searchable, chat-enabled knowledge base.

## Architecture Overview

```text
L1 Sources (raw materials)  →  L2 Notes (structured notes)  →  L3 Insights (planned)
         ↓                              ↓
   embeddings + full-text index   embeddings + structured metadata
         ↓                              ↓
              ┌─────────────────────┐
              │   Retriever Agent   │  (deterministic retrieval: SQL / vector / hybrid)
              └─────────┬───────────┘
                        ↓
              ┌─────────────────────┐
              │    Action Agent     │  (model-driven: Strands Agent + LLM)
              └─────────────────────┘
```

- **Retriever Agent**: deterministic retrieval layer with SQL filters, vector similarity, and hybrid search
- **Action Agent**: a Strands-based LLM agent that can call knowledge tools autonomously

## Tech Stack

| Layer | Technology |
|---|---|
| Backend framework | FastAPI + Uvicorn |
| Database | PostgreSQL 16 + pgvector |
| ORM | SQLAlchemy (async) + Alembic |
| Embeddings | Qwen `text-embedding-v4` (DashScope cloud API) |
| LLM | Azure OpenAI / Qwen (switchable) |
| Agent framework | Strands Agents |
| CLI | Typer + Rich |
| Frontend | React 19 + TypeScript + Tailwind CSS + Vite |

## Quick Start

### 1. Start core services

```bash
docker compose up -d
```

This starts PostgreSQL and MinIO. Default endpoints:

- PostgreSQL: `localhost:5433`
- MinIO API: `http://127.0.0.1:9000`
- MinIO Console: `http://127.0.0.1:9001`

### 2. Install Python dependencies

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

### 3. Configure environment variables

```bash
cp .env.example .env
# Edit `.env` and fill in your chat-model and embedding API keys
```

`docker-compose.yml` now reads PostgreSQL and MinIO credentials from `.env` instead of hardcoding default passwords in the committed compose file.

Key configuration values:

| Variable | Description | Default |
|---|---|---|
| `LLM_PROVIDER` | LLM provider (`azure` / `qwen`) | `qwen` |
| `QWEN_API_KEY` | Qwen chat API key | — |
| `EMBEDDING_API_BASE` | Embedding API base URL using the DashScope OpenAI-compatible endpoint | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `EMBEDDING_API_KEY` | Embedding API key, can be different from the chat-model account/plan | — |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key | — |
| `EMBEDDING_MODEL` | Embedding model | `text-embedding-v4` |
| `DATABASE_URL` | Database connection string | `postgresql+asyncpg://...localhost:5433/knowledge_graph` |
| `POSTGRES_PASSWORD` | Local PostgreSQL password used by Docker Compose | `local-dev-postgres-password` |
| `MINIO_ENDPOINT` | MinIO / S3-compatible endpoint | `http://127.0.0.1:9000` |
| `MINIO_ROOT_PASSWORD` | Local MinIO root password used by Docker Compose | `local-dev-minio-password` |
| `MINIO_BUCKET` | Bucket for uploaded files | `knowledge-graph` |

### 4. Initialize the database

```bash
alembic upgrade head
```

### 5. Import knowledge

Put Markdown files into `data/sources/` (raw materials) and `data/notes/` (notes), then sync:

```bash
pkg sync
```

## CLI Usage

```bash
# Sync Markdown files into the database
pkg sync

# Search the knowledge base
pkg search "knowledge graph"
pkg search "embedding" --mode vector --top-k 10

# Quickly add notes / sources
pkg add-note "Meeting Notes" --content "..." --tags meeting
pkg add-source "Paper Title" --source-type article --url "https://..."

# View statistics
pkg stats

# One-shot question answering over the knowledge base
pkg ask "Summarize the design ideas behind the three-layer architecture"

# Interactive multi-turn chat
pkg chat

# Start the API server
pkg serve
```

## API

After starting the server, open `http://localhost:8000/docs` for the full API documentation.

Main endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/sources` | List sources |
| `POST` | `/sources/upload` | Upload source files to MinIO |
| `GET` | `/sources/{id}/file` | Open the original source file |
| `GET` | `/notes` | List notes |
| `POST` | `/notes/upload` | Upload note files to MinIO |
| `GET` | `/notes/{id}/file` | Open the original note file |
| `POST` | `/search` | Search the knowledge base |
| `POST` | `/action` | Invoke the Action Agent |

## Frontend

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:5173`.

## Project Structure

```text
src/pkg/
├── api/              # FastAPI routes
│   ├── app.py        # Application entrypoint
│   ├── sources.py    # Source CRUD
│   ├── notes.py      # Note CRUD
│   ├── search.py     # Search API
│   └── action.py     # Action Agent API
├── models/           # SQLAlchemy models
├── schemas/          # Pydantic schemas
├── services/
│   ├── embedding.py      # Embedding service
│   ├── retriever.py      # Deterministic retrieval agent
│   ├── action_agent.py   # Model-driven action agent
│   ├── llm.py            # LLM client
│   ├── storage.py        # MinIO / object storage service
│   ├── sync_pipeline.py  # Markdown sync pipeline
│   └── tools.py          # Agent tool definitions
├── cli.py            # Typer CLI
├── config.py         # Configuration management
└── db.py             # Database connection
web/                  # React frontend
data/
├── sources/          # Raw source materials (Markdown)
└── notes/            # Structured notes (Markdown)
```

## License

Private project.
