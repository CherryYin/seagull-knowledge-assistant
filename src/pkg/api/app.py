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
from pkg.api.assets import router as assets_router
from pkg.api.agent_runs import router as agent_runs_router
from pkg.api.wiki import router as wiki_router
from pkg.api.memory import router as memory_router
from pkg.api.connectors import router as connectors_router
from pkg.api.calendar_reminders import router as calendar_reminders_router
from pkg.api.review import router as review_router
from pkg.api.discovery import router as discovery_router
from pkg.api.paper_discovery import router as paper_discovery_router
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


async def _daily_summarizer_loop():
    """Run the temporary-notes summarizer once per day at ~02:00 UTC."""
    from pkg.services.foundation.daily_summarizer import summarize_temporary_notes

    while True:
        now = datetime.now(timezone.utc)
        next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        delay = (next_run - now).total_seconds()
        logger.info("Daily summarizer: next run in %.0f seconds (%s)", delay, next_run.isoformat())
        await asyncio.sleep(delay)
        try:
            from pkg.services.cross_cutting.system_jobs import record_system_job

            async with record_system_job(job_type="daily_summarizer", title="Daily summarizer"):
                await summarize_temporary_notes()
        except Exception:
            logger.exception("Daily summarization failed")


async def _user_profiler_loop():
    """Run user profiling once per week (configurable day, 03:00 UTC)."""
    from pkg.config import settings
    from pkg.services.cross_cutting.user_profiler import profile_all_users

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
            from pkg.services.cross_cutting.system_jobs import record_system_job

            async with record_system_job(job_type="user_profiler", title="Weekly user profiling"):
                await profile_all_users()
        except Exception:
            logger.exception("User profiling failed")


async def _rss_fetcher_loop():
    """Fetch RSS feeds every RSS_FETCH_INTERVAL_HOURS (first run ~60s after startup)."""
    from pkg.services.foundation.rss_fetcher import cleanup_old_rss_articles, fetch_all_feeds

    await asyncio.sleep(60)
    while True:
        try:
            from pkg.services.cross_cutting.system_jobs import record_system_job

            async with record_system_job(job_type="rss_fetch", title="RSS fetch and cleanup") as job:
                stats = await fetch_all_feeds()
                deleted = await cleanup_old_rss_articles()
                job.metadata_ = {"stats": stats, "deleted": deleted}
            logger.info("RSS fetch complete: %s, cleaned %d old articles", stats, deleted)
        except Exception:
            logger.exception("RSS fetch loop failed")
        await asyncio.sleep(settings.RSS_FETCH_INTERVAL_HOURS * 3600)


async def _rss_summary_loop():
    """Summarize RSS articles every RSS_SUMMARY_INTERVAL_HOURS (first run ~5min after startup)."""
    from pkg.services.foundation.rss_summarizer import summarize_rss_by_topic

    await asyncio.sleep(300)
    while True:
        try:
            from pkg.services.cross_cutting.system_jobs import record_system_job

            async with record_system_job(job_type="rss_summary", title="RSS topic summarization") as job:
                note_ids = await summarize_rss_by_topic()
                job.metadata_ = {"note_ids": note_ids, "created": len(note_ids)}
            logger.info("RSS summary complete: created %d topic notes", len(note_ids))
        except Exception:
            logger.exception("RSS summary loop failed")
        await asyncio.sleep(settings.RSS_SUMMARY_INTERVAL_HOURS * 3600)


async def _connector_trends_loop():
    """Collect arXiv/GitHub daily trends when explicitly enabled."""
    from pkg.services.foundation.connector_trends import collect_daily_connector_trends

    await asyncio.sleep(300)
    while True:
        try:
            from pkg.services.cross_cutting.system_jobs import record_system_job

            async with record_system_job(job_type="connector_trends", title="Connector trend discovery") as job:
                stats = await collect_daily_connector_trends()
                job.metadata_ = {"stats": stats}
            logger.info("Connector trend discovery complete: %s", stats)
        except Exception:
            logger.exception("Connector trend discovery failed")
        await asyncio.sleep(settings.CONNECTOR_TRENDS_INTERVAL_HOURS * 3600)


async def _discovery_generate_loop():
    """Generate personalized discovery items from existing connector/RSS/web inputs."""
    from sqlalchemy import select

    from pkg.db import async_session
    from pkg.models.user import User
    from pkg.services.foundation.discovery import generate_discovery_items
    from pkg.services.cross_cutting.system_jobs import record_system_job

    await asyncio.sleep(180)
    while True:
        try:
            async with record_system_job(job_type="discovery_generate", title="Discovery item generation") as job:
                async with async_session() as session:
                    rows = await session.execute(select(User.id).where(User.is_active.is_(True)))
                    user_ids = list(rows.scalars())
                totals = {"users": len(user_ids), "created": 0, "updated": 0, "skipped": 0}
                for user_id in user_ids:
                    async with async_session() as session:
                        created, updated, skipped = await generate_discovery_items(session, user_id=user_id, limit=100)
                        totals["created"] += created
                        totals["updated"] += updated
                        totals["skipped"] += skipped
                        logger.info("Discovery generated for user %s: created=%d updated=%d skipped=%d", user_id, created, updated, skipped)
                job.metadata_ = totals
        except Exception:
            logger.exception("Discovery generation failed")
        await asyncio.sleep(settings.DISCOVERY_GENERATE_INTERVAL_HOURS * 3600)


async def _paper_discovery_loop():
    from pkg.db import async_session
    from pkg.services.foundation.paper_discovery_jobs import run_scheduled_paper_discovery_profiles
    from pkg.services.cross_cutting.system_jobs import record_system_job

    await asyncio.sleep(60)
    while True:
        try:
            async with record_system_job(job_type="paper_discovery", title="Scheduled paper discovery") as job:
                async with async_session() as session:
                    stats = await run_scheduled_paper_discovery_profiles(session)
                    job.metadata_ = stats
        except Exception:
            logger.exception("Scheduled paper discovery failed")
        await asyncio.sleep(settings.PAPER_DISCOVERY_INTERVAL_HOURS * 3600)


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
    if os.environ.get("KG_DISABLE_BACKGROUND_TASKS", "").lower() in {"1", "true", "yes"} or is_test_process:
        logger.info("Background loops disabled for this process.")
        yield
        return

    background_tasks = [
        asyncio.create_task(_daily_summarizer_loop()),
        asyncio.create_task(_user_profiler_loop()),
    ]
    if settings.RSS_AUTO_FETCH_ENABLED:
        background_tasks.append(asyncio.create_task(_rss_fetcher_loop()))
    else:
        logger.info("RSS auto-fetch loop disabled. Set RSS_AUTO_FETCH_ENABLED=true to enable it.")
    if settings.RSS_AUTO_SUMMARY_ENABLED:
        background_tasks.append(asyncio.create_task(_rss_summary_loop()))
    else:
        logger.info("RSS auto-summary loop disabled. Set RSS_AUTO_SUMMARY_ENABLED=true to enable it.")
    if settings.CONNECTOR_TRENDS_AUTO_ENABLED:
        background_tasks.append(asyncio.create_task(_connector_trends_loop()))
    else:
        logger.info("Connector trend discovery disabled. Set CONNECTOR_TRENDS_AUTO_ENABLED=true to enable it.")
    if settings.DISCOVERY_AUTO_GENERATE_ENABLED:
        background_tasks.append(asyncio.create_task(_discovery_generate_loop()))
    else:
        logger.info("Discovery auto-generation disabled. Set DISCOVERY_AUTO_GENERATE_ENABLED=true to enable it.")
    if settings.PAPER_DISCOVERY_AUTO_ENABLED:
        background_tasks.append(asyncio.create_task(_paper_discovery_loop()))
    else:
        logger.info("Paper discovery auto-run disabled. Set PAPER_DISCOVERY_AUTO_ENABLED=true to enable it.")
    yield
    for background_task in background_tasks:
        background_task.cancel()


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
app.include_router(assets_router, prefix="/assets", tags=["assets"])
app.include_router(agent_runs_router, prefix="/agent-runs", tags=["agent-runs"])
app.include_router(wiki_router, prefix="/wiki", tags=["wiki"])
app.include_router(memory_router, prefix="/memory", tags=["memory"])
app.include_router(connectors_router, prefix="/connectors", tags=["connectors"])
app.include_router(calendar_reminders_router, prefix="/calendar/reminders", tags=["calendar"])
app.include_router(review_router, prefix="/review", tags=["review"])
app.include_router(discovery_router, prefix="/discovery", tags=["discovery"])
app.include_router(paper_discovery_router, prefix="/paper-discovery", tags=["paper-discovery"])
app.include_router(system_jobs_router, prefix="/system/jobs", tags=["system-jobs"])


@app.get("/health")
async def health():
    return {"status": "ok"}
