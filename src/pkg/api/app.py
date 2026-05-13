import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
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
from pkg.api.action import router as action_router
from pkg.api.chat_sessions import router as chat_sessions_router
from pkg.api.skills import router as skills_router
from pkg.api.knowledge import router as knowledge_router
from pkg.api.models import router as models_router
from pkg.api.dashboard import router as dashboard_router
from pkg.api.categories import router as categories_router
from pkg.api.auth import router as auth_router
from pkg.api.agent_profiles import router as agent_profiles_router

# Configure root logger so all app loggers (pkg.*) output to console.
# This is a no-op if logging is already configured (e.g. by pytest).
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s [%(name)s] %(message)s",
)

logger = logging.getLogger(__name__)


async def _daily_summarizer_loop():
    """Run the temporary-notes summarizer once per day at ~02:00 UTC."""
    from pkg.services.daily_summarizer import summarize_temporary_notes

    while True:
        now = datetime.now(timezone.utc)
        next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        delay = (next_run - now).total_seconds()
        logger.info("Daily summarizer: next run in %.0f seconds (%s)", delay, next_run.isoformat())
        await asyncio.sleep(delay)
        try:
            await summarize_temporary_notes()
        except Exception:
            logger.exception("Daily summarization failed")


async def _user_profiler_loop():
    """Run user profiling once per week (configurable day, 03:00 UTC)."""
    from pkg.config import settings
    from pkg.services.user_profiler import profile_all_users

    while True:
        now = datetime.now(timezone.utc)
        target_day = settings.PROFILE_UPDATE_DAY  # 0=Monday
        days_ahead = (target_day - now.weekday()) % 7
        if days_ahead == 0 and now.hour >= 3:
            days_ahead = 7
        next_run = (now + timedelta(days=days_ahead)).replace(hour=3, minute=0, second=0, microsecond=0)
        delay = (next_run - now).total_seconds()
        logger.info("User profiler: next run in %.0f seconds (%s)", delay, next_run.isoformat())
        await asyncio.sleep(delay)
        try:
            await profile_all_users()
        except Exception:
            logger.exception("User profiling failed")


async def _rss_fetcher_loop():
    """Fetch RSS feeds every RSS_FETCH_INTERVAL_HOURS (first run ~60s after startup)."""
    from pkg.services.rss_fetcher import cleanup_old_rss_articles, fetch_all_feeds

    await asyncio.sleep(60)
    while True:
        try:
            stats = await fetch_all_feeds()
            deleted = await cleanup_old_rss_articles()
            logger.info("RSS fetch complete: %s, cleaned %d old articles", stats, deleted)
        except Exception:
            logger.exception("RSS fetch loop failed")
        await asyncio.sleep(settings.RSS_FETCH_INTERVAL_HOURS * 3600)


async def _rss_summary_loop():
    """Summarize RSS articles every RSS_SUMMARY_INTERVAL_HOURS (first run ~5min after startup)."""
    from pkg.services.rss_summarizer import summarize_rss_by_topic

    await asyncio.sleep(300)
    while True:
        try:
            note_ids = await summarize_rss_by_topic()
            logger.info("RSS summary complete: created %d topic notes", len(note_ids))
        except Exception:
            logger.exception("RSS summary loop failed")
        await asyncio.sleep(settings.RSS_SUMMARY_INTERVAL_HOURS * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.JWT_SECRET_KEY or len(settings.JWT_SECRET_KEY) < 32:
        raise RuntimeError(
            "JWT_SECRET_KEY must be set to a random string of at least 32 characters. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    if not settings.ADMIN_INIT_PASSWORD or settings.ADMIN_INIT_PASSWORD in ("admin123", "password"):
        logger.warning(
            "ADMIN_INIT_PASSWORD is empty or weak — set a strong password in .env"
        )
    task = asyncio.create_task(_daily_summarizer_loop())
    profiler_task = asyncio.create_task(_user_profiler_loop())
    rss_fetch_task = asyncio.create_task(_rss_fetcher_loop())
    rss_summary_task = asyncio.create_task(_rss_summary_loop())
    yield
    task.cancel()
    profiler_task.cancel()
    rss_fetch_task.cancel()
    rss_summary_task.cancel()


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
app.include_router(action_router, tags=["action"])
app.include_router(chat_sessions_router, prefix="/chat-sessions", tags=["chat-sessions"])
app.include_router(skills_router, prefix="/skills", tags=["skills"])
app.include_router(knowledge_router, prefix="/knowledge", tags=["knowledge"])
app.include_router(models_router, prefix="/knowledge", tags=["models"])
app.include_router(dashboard_router, prefix="/knowledge", tags=["dashboard"])
app.include_router(categories_router, prefix="/categories", tags=["categories"])
app.include_router(auth_router, prefix="/auth", tags=["auth"])
app.include_router(agent_profiles_router, prefix="/agent-profiles", tags=["agent-profiles"])


@app.get("/health")
async def health():
    return {"status": "ok"}
