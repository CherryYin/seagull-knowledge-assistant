import logging
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

from pkg.config import settings
from pkg.api.sources import router as sources_router
from pkg.api.notes import router as notes_router
from pkg.api.search import router as search_router
from pkg.api.completion import router as completion_router
from pkg.api.chat_sessions import router as chat_sessions_router
from pkg.api.knowledge import router as knowledge_router
from pkg.api.models import router as models_router
from pkg.api.dashboard import router as dashboard_router
from pkg.api.categories import router as categories_router
from pkg.api.auth import router as auth_router
from pkg.api.assets import router as assets_router
from pkg.api.wiki import router as wiki_router
from pkg.api.connectors import router as connectors_router
from pkg.api.calendar_reminders import router as calendar_reminders_router
from pkg.api.review import router as review_router
from pkg.api.discovery import router as discovery_router
from pkg.api.paper_discovery import router as paper_discovery_router
from pkg.api.system import router as system_router
from pkg.api.system_jobs import router as system_jobs_router

# Configure root logger so all app loggers (pkg.*) output to console.
# This is a no-op if logging is already configured (e.g. by pytest).
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s [%(name)s] %(message)s",
)

logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)


class _OpenTelemetryDetachContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "opentelemetry.context" or record.getMessage() != "Failed to detach context":
            return True
        if not record.exc_info:
            return True
        exc = record.exc_info[1]
        return not isinstance(exc, ValueError) or "created in a different Context" not in str(exc)


def _suppress_stream_disconnect_otel_noise() -> None:
    logging.getLogger("opentelemetry.context").addFilter(_OpenTelemetryDetachContextFilter())

_suppress_stream_disconnect_otel_noise()


def _is_strong_admin_password(value: str | None) -> bool:
    return bool(value) and value not in {"admin123", "password"} and len(value) >= 12


async def _active_admin_exists() -> bool:
    from sqlalchemy import select

    from pkg.db import async_session
    from pkg.models.user import User

    async with async_session() as session:
        result = await session.execute(
            select(User.id).where(User.role == "admin", User.is_active.is_(True)).limit(1)
        )
        return result.scalar_one_or_none() is not None


async def _enforce_admin_init_password_if_needed() -> None:
    if _is_strong_admin_password(settings.ADMIN_INIT_PASSWORD):
        return
    try:
        if await _active_admin_exists():
            logger.warning("ADMIN_INIT_PASSWORD is empty or weak, but an active admin already exists; skipping initialization password enforcement.")
            return
    except Exception:
        logger.warning("Could not verify whether an active admin exists while checking ADMIN_INIT_PASSWORD.", exc_info=True)
        return
    raise RuntimeError("ADMIN_INIT_PASSWORD must be set to a strong password of at least 12 characters before initializing the first admin")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.JWT_SECRET_KEY or len(settings.JWT_SECRET_KEY) < 32:
        raise RuntimeError(
            "JWT_SECRET_KEY must be set to a random string of at least 32 characters. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    is_test_process = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    if not is_test_process:
        await _enforce_admin_init_password_if_needed()
    yield


app = FastAPI(
    title="Personal Knowledge Graph",
    version="0.1.0",
    description="Three-layer knowledge mining system — Phase 1: L1 Sources + L2 Notes",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sources_router, prefix="/sources", tags=["sources"])
app.include_router(notes_router, prefix="/notes", tags=["notes"])
app.include_router(search_router, tags=["search"])
app.include_router(completion_router, tags=["completion"])
app.include_router(chat_sessions_router, prefix="/chat-sessions", tags=["chat-sessions"])
app.include_router(knowledge_router, prefix="/knowledge", tags=["knowledge"])
app.include_router(models_router, prefix="/knowledge", tags=["models"])
app.include_router(dashboard_router, prefix="/knowledge", tags=["dashboard"])
app.include_router(categories_router, prefix="/categories", tags=["categories"])
app.include_router(auth_router, prefix="/auth", tags=["auth"])
app.include_router(assets_router, prefix="/assets", tags=["assets"])
app.include_router(wiki_router, prefix="/wiki", tags=["wiki"])
app.include_router(connectors_router, prefix="/connectors", tags=["connectors"])
app.include_router(calendar_reminders_router, prefix="/calendar/reminders", tags=["calendar"])
app.include_router(review_router, prefix="/review", tags=["review"])
app.include_router(discovery_router, prefix="/discovery", tags=["discovery"])
app.include_router(paper_discovery_router, prefix="/paper-discovery", tags=["paper-discovery"])
app.include_router(system_router, prefix="/system", tags=["system"])
app.include_router(system_jobs_router, prefix="/system/jobs", tags=["system-jobs"])


@app.get("/health")
async def health():
    return {"status": "ok"}
