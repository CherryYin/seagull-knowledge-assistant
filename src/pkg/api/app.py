import os
from contextlib import asynccontextmanager
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore[misc, assignment]

# Load .env early so KG_TORCH_CPU_ONLY applies before PyTorch may be imported later.
if load_dotenv is not None:
    _here = Path(__file__).resolve()
    for _base in (_here.parents[3], Path.cwd()):
        _env = _base / ".env"
        if _env.is_file():
            load_dotenv(_env)
            break

# Set before any dependency imports PyTorch (Docling/RapidOCR). Avoids slow CUDA probe + driver warnings on WSL/old drivers.
if os.environ.get("KG_TORCH_CPU_ONLY", "").lower() in ("1", "true", "yes"):
    os.environ["CUDA_VISIBLE_DEVICES"] = ""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pkg.api.sources import router as sources_router
from pkg.api.notes import router as notes_router
from pkg.api.search import router as search_router
from pkg.api.action import router as action_router
from pkg.api.chat_sessions import router as chat_sessions_router
from pkg.api.skills import router as skills_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="Personal Knowledge Graph",
    version="0.1.0",
    description="Three-layer knowledge mining system — Phase 1: L1 Sources + L2 Notes",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sources_router, prefix="/sources", tags=["sources"])
app.include_router(notes_router, prefix="/notes", tags=["notes"])
app.include_router(search_router, tags=["search"])
app.include_router(action_router, tags=["action"])
app.include_router(chat_sessions_router, prefix="/chat-sessions", tags=["chat-sessions"])
app.include_router(skills_router, prefix="/skills", tags=["skills"])


@app.get("/health")
async def health():
    return {"status": "ok"}
