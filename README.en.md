<p align="center">
  <img src="assets/seagull.png" alt="Seagull Logo" width="180" />
</p>

<h1 align="center">Seagull — Personal Knowledge Graph</h1>

<p align="center">
  A three-layer personal knowledge mining system that turns Markdown notes, PDFs, and other raw materials into a searchable, chat-enabled intelligent knowledge base.
</p>

<p align="center">
  <a href="README.md">中文</a> | <a href="README.en.md">English</a>
</p>

## Architecture

```text
L1 Sources (raw materials)  →  L2 Notes (structured notes)  →  L3 Insights (planned)
         ↓                              ↓
   vector embeddings             vector embeddings
   + chunk embeddings            + structured metadata
   + full-text index             + full-text index
         ↓                              ↓
              ┌─────────────────────┐
              │   Retriever Agent   │  (deterministic: SQL / vector / hybrid)
              └─────────┬───────────┘
                        ↓
              ┌─────────────────────┐
              │    Action Agent     │  (model-driven: Strands Agent + LLM)
              │   9 built-in tools  │
              │   + dynamic Skills  │
              └─────────────────────┘
```

- **Retriever Agent** — deterministic retrieval layer with SQL filters, vector similarity, and hybrid search
- **Action Agent** — a Strands-based LLM agent that autonomously calls knowledge tools to complete complex tasks

## Key Features

- **Multi-format document ingestion** — PDF, DOCX, PPTX, XLSX, HTML, images with automatic OCR for scanned documents (Tesseract / RapidOCR)
- **Smart chunking & embeddings** — long documents are automatically split into overlapping chunks (512 chars, 64 overlap), each chunk independently embedded for fine-grained retrieval
- **Three search modes** — vector semantic search, SQL structured filtering, hybrid search with automatic mode selection
- **AI agent chat** — multi-turn conversations where the agent can search the knowledge base, read documents, process files, and search the web
- **Web search** — Tavily API integration for real-time internet search
- **Skills system** — reusable prompt templates (20+ built-in), extensible with custom Python tools
- **File storage** — MinIO / S3-compatible object storage with file upload and presigned download URLs
- **Session persistence** — conversation history stored in the database with session management and replay
- **Agent Profiles** — users can create multiple agent configurations (custom instructions, model selection, tool/skill whitelists, temperature) and switch between them in conversations

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + Uvicorn |
| Database | PostgreSQL 16 + pgvector (HNSW indexes) |
| ORM | SQLAlchemy 2.0 (async) + Alembic |
| Embeddings | Qwen `text-embedding-v4` (1024 dims) |
| LLM | Azure OpenAI / Qwen (switchable) |
| Agent framework | Strands Agents |
| Document parsing | Docling (PDF/DOCX/PPTX/XLSX) + Tesseract OCR |
| Web search | Tavily API |
| File storage | MinIO (S3-compatible) |
| CLI | Typer + Rich |
| Frontend | React 19 + TypeScript + Tailwind CSS 4 + Vite |

## Quick Start

### 1. Start core services

```bash
docker compose up -d
```

This starts PostgreSQL and MinIO:

- PostgreSQL: `localhost:5433`
- MinIO API: `http://127.0.0.1:9000`
- MinIO Console: `http://127.0.0.1:9001`

### 2. Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Tesseract OCR (optional, for scanned document recognition):

```bash
sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim libtesseract-dev
```

### 3. Configure environment

```bash
cp .env.example .env
```

Key configuration:

| Variable | Description | Default |
|---|---|---|
| `LLM_PROVIDER` | LLM provider (`azure` / `qwen`) | `qwen` |
| `QWEN_API_KEY` | Qwen API key | — |
| `EMBEDDING_API_KEY` | Embedding API key | — |
| `EMBEDDING_MODEL` | Embedding model | `text-embedding-v4` |
| `TAVILY_API_KEY` | Tavily web search API key | — |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key (when using Azure) | — |
| `DATABASE_URL` | Database connection | `postgresql+asyncpg://...localhost:5433/knowledge_graph` |
| `POSTGRES_PASSWORD` | PostgreSQL password (for Docker Compose) | — |
| `MINIO_ENDPOINT` | MinIO endpoint | `http://127.0.0.1:9000` |
| `MINIO_ROOT_PASSWORD` | MinIO password (for Docker Compose) | — |
| `DOCLING_OCR_ENGINE` | OCR engine (`tesseract` / `rapidocr`) | `tesseract` |
| `CHUNK_SIZE` | Chunk size in characters | `512` |
| `CHUNK_OVERLAP` | Chunk overlap in characters | `64` |
| `ALLOWED_MODELS` | User-selectable LLM models (JSON array) | `["qwen-plus","qwen-max","qwen-turbo"]` |
| `JWT_SECRET_KEY` | JWT signing secret (min 32 chars) | — |
| `ADMIN_INIT_PASSWORD` | Admin initial password | — |

### 4. Initialize the database

```bash
alembic upgrade head
```

### 5. Import knowledge

Place files in `data/sources/` (raw materials) and `data/notes/` (notes). Supports Markdown and binary documents (PDF, DOCX, etc.):

```bash
pkg sync
```

### 6. Start services

**Backend API:**

```bash
# Option 1: Using the CLI command (recommended for dev, includes hot reload)
pkg serve

# Option 2: Using uvicorn directly
uvicorn pkg.api.app:app --host 127.0.0.1 --port 8000 --reload
```

The backend runs at `http://localhost:8000` by default. Swagger docs at `http://localhost:8000/docs`.

**Frontend:**

```bash
cd web
npm install    # first run or when dependencies change
npm run dev
```

The frontend runs at `http://localhost:5173` by default, with a proxy configured to forward `/api` requests to the backend.

## CLI Usage

```bash
pkg sync                                          # Sync files to database
pkg search "knowledge graph"                      # Search knowledge base
pkg search "embedding" --mode vector --top-k 10   # Vector search
pkg add-note "Meeting Notes" --content "..." --tags meeting  # Add a note
pkg add-source "Paper Title" --source-type article           # Add a source
pkg stats                                          # View statistics
pkg ask "Summarize the three-layer architecture"   # One-shot Q&A
pkg chat                                           # Multi-turn chat
pkg skills                                         # List available skills
pkg serve                                          # Start API server
```

## Agent Tools

The Action Agent has the following built-in tools and selects them autonomously based on the task:

| Tool | Description |
|---|---|
| `search_knowledge` | Semantic / structured knowledge base search |
| `read_note` | Read full note content |
| `read_source` | Read full source content |
| `list_notes` | Browse notes by domain / tag / project |
| `list_sources` | Browse sources by type |
| `knowledge_stats` | Knowledge base statistics |
| `process_document` | Document processing (PDF/DOCX/XLSX/PPTX operations) |
| `web_search` | Internet search (Tavily) |

The agent also dynamically loads Skill tools from the `skills/` directory.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET/POST` | `/sources` | List / create sources |
| `POST` | `/sources/upload` | Upload source files |
| `GET` | `/sources/{id}` | Get source details |
| `GET` | `/sources/{id}/file` | Download original source file |
| `GET/POST` | `/notes` | List / create notes |
| `PATCH` | `/notes/{id}` | Update a note |
| `POST` | `/notes/upload` | Upload note files |
| `POST` | `/search` | Search the knowledge base |
| `POST` | `/action` | Invoke the Action Agent |
| `POST` | `/action/stream` | Stream Action Agent response |
| `GET/POST` | `/chat-sessions` | Session management |
| `GET/PATCH/DELETE` | `/chat-sessions/{id}` | Session details / update / delete |
| `GET/POST` | `/agent-profiles` | Agent Profile management |
| `GET/PATCH/DELETE` | `/agent-profiles/{id}` | Profile details / update / delete |
| `POST` | `/agent-profiles/{id}/set-default` | Set as default profile |
| `GET` | `/agent-profiles/available-tools` | Available tools list |
| `GET` | `/agent-profiles/allowed-models` | Allowed models list |
| `GET/POST` | `/skills` | Skills management |
| `POST` | `/sync` | Trigger file sync |

## Project Structure

```text
src/pkg/
├── api/                    # FastAPI routes
│   ├── app.py              # App entrypoint & middleware
│   ├── sources.py          # Source CRUD + file upload
│   ├── notes.py            # Note CRUD + file upload
│   ├── search.py           # Search + sync endpoints
│   ├── action.py           # Action Agent API (sync / streaming)
│   ├── chat_sessions.py    # Multi-turn session management
│   ├── agent_profiles.py   # Agent Profile CRUD
│   └── skills.py           # Skills CRUD
├── models/                 # SQLAlchemy models
│   ├── source.py           # Source + SourceEmbedding + SourceChunk
│   ├── note.py             # Note + NoteEmbedding
│   ├── chat_session.py     # ChatSession
│   ├── agent_profile.py    # AgentProfile
│   └── skill.py            # Skill
├── schemas/                # Pydantic validation schemas
├── services/
│   ├── retriever.py        # Retriever Agent (SQL / vector / hybrid)
│   ├── action_agent.py     # Action Agent + system prompt
│   ├── llm.py              # LLM client factory (Azure / Qwen)
│   ├── embedding.py        # Embedding service (auto-batching)
│   ├── chunking.py         # Document chunking
│   ├── document_extractor.py  # Docling extraction + OCR
│   ├── storage.py          # MinIO object storage
│   ├── sync_pipeline.py    # File sync pipeline
│   ├── tools.py            # Knowledge tools (search / read / stats)
│   ├── tools_web.py        # Web search tool (Tavily)
│   ├── tools_document.py   # Document processing tool
│   └── skills.py           # Skill loading & expansion
├── cli.py                  # Typer CLI
├── config.py               # Configuration management
└── db.py                   # Database connection
web/                        # React frontend
├── src/pages/              # Pages: Chat, Search, Notes, Sources, Skills, Profiles
├── src/components/         # Components: ChatMessage, SearchResultCard, Layout
└── src/lib/                # API client, utilities
skills/                     # Skill templates (20+ built-in)
data/
├── sources/                # Raw source materials
└── notes/                  # Structured notes
```

## License

Private project.
