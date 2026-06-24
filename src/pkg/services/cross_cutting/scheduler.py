import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from time import perf_counter
from typing import AsyncIterator, Awaitable, Callable, Literal

from sqlalchemy import select

from pkg.config import settings
from pkg.db import async_session
from pkg.models.user import User
from pkg.services.cross_cutting.system_jobs import record_system_job
from pkg.services.cross_cutting.system_jobs import get_last_terminal_job_run


ScheduleKind = Literal["interval", "daily", "weekly"]
TaskHandler = Callable[[], Awaitable[dict | None] | Awaitable[None]]
logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ScheduledTask:
    name: str
    job_type: str
    title: str
    handler: TaskHandler
    schedule_type: ScheduleKind
    enabled: bool = True
    interval_seconds: int | None = None
    daily_time_utc: time | None = None
    weekday_utc: int | None = None
    weekly_time_utc: time | None = None
    timeout_seconds: int | None = None
    jitter_seconds: int = 0
    initial_delay_seconds: int = 0


@dataclass(slots=True)
class TaskRunResult:
    status: Literal["completed", "failed", "skipped"]
    metadata: dict | None = None
    reason: str | None = None


def is_task_due(task: ScheduledTask, now: datetime, last_run: datetime | None) -> bool:
    current = _ensure_utc(now)
    previous = _ensure_utc(last_run) if last_run else None

    if not task.enabled:
        return False

    if task.schedule_type == "interval":
        return _is_interval_due(task, current, previous)
    if task.schedule_type == "daily":
        return _is_daily_due(task, current, previous)
    if task.schedule_type == "weekly":
        return _is_weekly_due(task, current, previous)
    raise ValueError(f"Unsupported schedule type: {task.schedule_type}")


@asynccontextmanager
async def acquire_task_lock(task_name: str) -> AsyncIterator[bool]:
    """Acquire a task-scoped execution lock.

    Current implementation is process-local no-op scaffolding so the scheduler
    keeps a stable lock boundary before we wire DB advisory locks.
    """
    _ = task_name
    yield True


async def run_scheduled_task(task: ScheduledTask) -> TaskRunResult:
    started = perf_counter()
    try:
        async with acquire_task_lock(task.name) as acquired:
            if not acquired:
                return TaskRunResult(status="skipped", reason="lock_not_acquired", metadata={"reason": "lock_not_acquired"})

            async with record_system_job(job_type=task.job_type, title=task.title) as job:
                try:
                    if task.timeout_seconds and task.timeout_seconds > 0:
                        raw_result = await asyncio.wait_for(task.handler(), timeout=task.timeout_seconds)
                    else:
                        raw_result = await task.handler()
                except asyncio.CancelledError:
                    raise
                except TimeoutError:
                    metadata = {"reason": "timeout", "timeout_seconds": task.timeout_seconds}
                    job.metadata_ = metadata
                    raise RuntimeError(f"Task timed out after {task.timeout_seconds} seconds")

                metadata = raw_result if isinstance(raw_result, dict) else None
                if metadata is not None:
                    job.metadata_ = metadata
                return TaskRunResult(status="completed", metadata=metadata)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        duration_ms = round((perf_counter() - started) * 1000, 2)
        return TaskRunResult(
            status="failed",
            reason=str(exc),
            metadata={"error": str(exc), "duration_ms": duration_ms},
        )


async def run_daily_summarizer_step() -> dict:
    from pkg.services.foundation.daily_summarizer import summarize_all_users_temporary_notes

    note_ids = await summarize_all_users_temporary_notes()
    created = len(note_ids)
    return {
        "note_ids": note_ids,
        "created": created,
        "reason": None if created else "no_temporary_notes",
    }


async def run_user_profiler_step() -> dict:
    from pkg.services.cross_cutting.user_profiler import profile_all_users

    async with async_session() as session:
        rows = await session.execute(select(User.id).where(User.is_active.is_(True)))
        user_ids = list(rows.scalars())

    active_users = len(user_ids)
    profiled = await profile_all_users()
    skipped = max(active_users - profiled, 0)
    return {
        "active_users": active_users,
        "profiled": profiled,
        "skipped": skipped,
        "reason": "no_active_users" if active_users == 0 else None,
    }


async def run_rss_fetch_step() -> dict:
    from pkg.services.foundation.rss_fetcher import cleanup_old_rss_articles, fetch_all_feeds

    stats = await fetch_all_feeds()
    deleted = await cleanup_old_rss_articles()
    feeds_checked = int(stats.get("feeds_checked", 0) or 0)
    new_articles = int(stats.get("new_articles", 0) or 0)
    errors = int(stats.get("errors", 0) or 0)
    reason = None
    if feeds_checked == 0:
        reason = "no_rss_enabled_feeds"
    elif new_articles == 0 and errors == 0:
        reason = "no_new_rss_articles"
    return {
        "stats": stats,
        "deleted": deleted,
        "feeds_checked": feeds_checked,
        "new_articles": new_articles,
        "errors": errors,
        "reason": reason,
    }


async def run_rss_summary_step() -> dict:
    from pkg.services.foundation.rss_summarizer import summarize_rss_by_topic

    note_ids = await summarize_rss_by_topic()
    created = len(note_ids)
    return {
        "note_ids": note_ids,
        "created": created,
        "reason": None if created else "no_recent_rss_articles",
    }


async def run_connector_trends_step() -> dict:
    from pkg.services.foundation.connector_trends import collect_daily_connector_trends

    stats = await collect_daily_connector_trends()
    return {"stats": stats}


async def run_discovery_generate_step() -> dict:
    from pkg.services.foundation.discovery import generate_discovery_items

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
    totals["candidate_count"] = totals["created"] + totals["updated"] + totals["skipped"]
    totals["reason"] = None
    if totals["users"] == 0:
        totals["reason"] = "no_active_users"
    elif totals["candidate_count"] == 0:
        totals["reason"] = "no_recent_rss_articles_or_connector_candidates"
    return totals


async def run_paper_discovery_step() -> dict:
    from pkg.services.foundation.paper_discovery_jobs import run_scheduled_paper_discovery_profiles

    async with async_session() as session:
        stats = await run_scheduled_paper_discovery_profiles(session)
    result = dict(stats)
    result["reason"] = None
    if int(result.get("profiles", 0) or 0) == 0:
        result["reason"] = "no_enabled_profiles"
    elif int(result.get("eligible", 0) or 0) == 0:
        result["reason"] = "no_due_profiles"
    return result


async def run_web_directory_discover_step() -> dict:
    from pkg.services.foundation.web_directory import run_web_directory_discover_step as run_step

    return await run_step()


async def run_web_refresh_step() -> dict:
    from pkg.services.foundation.web_extractor import run_web_refresh_step as run_step

    return await run_step()


def get_scheduled_tasks() -> list[ScheduledTask]:
    tasks = [
        ScheduledTask(
            name="daily_summarizer",
            job_type="daily_summarizer",
            title="Daily summarizer",
            handler=run_daily_summarizer_step,
            schedule_type="daily",
            daily_time_utc=time(hour=2, minute=0),
        ),
        ScheduledTask(
            name="user_profiler",
            job_type="user_profiler",
            title="Weekly user profiling",
            handler=run_user_profiler_step,
            schedule_type="weekly",
            weekday_utc=settings.PROFILE_UPDATE_DAY,
            weekly_time_utc=time(hour=3, minute=0),
        ),
        ScheduledTask(
            name="rss_fetch",
            job_type="rss_fetch",
            title="RSS fetch and cleanup",
            handler=run_rss_fetch_step,
            schedule_type="interval",
            interval_seconds=settings.RSS_FETCH_INTERVAL_HOURS * 3600,
            initial_delay_seconds=60,
            enabled=settings.RSS_AUTO_FETCH_ENABLED,
        ),
        ScheduledTask(
            name="rss_summary",
            job_type="rss_summary",
            title="RSS topic summarization",
            handler=run_rss_summary_step,
            schedule_type="interval",
            interval_seconds=settings.RSS_SUMMARY_INTERVAL_HOURS * 3600,
            initial_delay_seconds=300,
            enabled=settings.RSS_AUTO_SUMMARY_ENABLED,
        ),
        ScheduledTask(
            name="connector_trends",
            job_type="connector_trends",
            title="Connector trend discovery",
            handler=run_connector_trends_step,
            schedule_type="interval",
            interval_seconds=settings.CONNECTOR_TRENDS_INTERVAL_HOURS * 3600,
            initial_delay_seconds=300,
            enabled=settings.CONNECTOR_TRENDS_AUTO_ENABLED,
        ),
        ScheduledTask(
            name="discovery_generate",
            job_type="discovery_generate",
            title="Discovery item generation",
            handler=run_discovery_generate_step,
            schedule_type="interval",
            interval_seconds=settings.DISCOVERY_GENERATE_INTERVAL_HOURS * 3600,
            initial_delay_seconds=180,
            enabled=settings.DISCOVERY_AUTO_GENERATE_ENABLED,
        ),
        ScheduledTask(
            name="web_directory_discover",
            job_type="web_directory_discover",
            title="Web directory auto discover",
            handler=run_web_directory_discover_step,
            schedule_type="interval",
            interval_seconds=settings.WEB_DIRECTORY_DISCOVER_INTERVAL_HOURS * 3600,
            enabled=settings.WEB_DIRECTORY_AUTO_DISCOVER_ENABLED,
        ),
        ScheduledTask(
            name="web_refresh",
            job_type="web_refresh",
            title="Web source auto refresh",
            handler=run_web_refresh_step,
            schedule_type="interval",
            interval_seconds=settings.WEB_REFRESH_INTERVAL_HOURS * 3600,
            enabled=settings.WEB_AUTO_REFRESH_ENABLED,
        ),
        ScheduledTask(
            name="paper_discovery",
            job_type="paper_discovery",
            title="Scheduled paper discovery",
            handler=run_paper_discovery_step,
            schedule_type="interval",
            interval_seconds=settings.PAPER_DISCOVERY_INTERVAL_HOURS * 3600,
            initial_delay_seconds=60,
            enabled=settings.PAPER_DISCOVERY_AUTO_ENABLED,
        ),
    ]
    return tasks


async def scheduled_pipeline_loop(*, poll_interval_seconds: int = 30) -> None:
    while True:
        now = datetime.now(timezone.utc)
        tasks = get_scheduled_tasks()
        for task in tasks:
            try:
                last_run = await get_last_terminal_job_run(task.job_type)
                if is_task_due(task, now, last_run):
                    result = await run_scheduled_task(task)
                    logger.info("Scheduled task %s finished with status=%s", task.name, result.status)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Scheduled pipeline failed while evaluating task %s", task.name)
        await asyncio.sleep(poll_interval_seconds)


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def next_task_run_at(task: ScheduledTask, now: datetime, last_run: datetime | None) -> datetime | None:
    current = _ensure_utc(now)
    previous = _ensure_utc(last_run) if last_run else None

    if not task.enabled:
        return None
    if task.schedule_type == "interval":
        if task.interval_seconds is None:
            raise ValueError(f"interval_seconds is required for task {task.name}")
        if previous is None:
            return current + timedelta(seconds=max(task.initial_delay_seconds, 0))
        return previous + timedelta(seconds=task.interval_seconds)
    if task.schedule_type == "daily":
        if task.daily_time_utc is None:
            raise ValueError(f"daily_time_utc is required for task {task.name}")
        scheduled_at = datetime.combine(current.date(), task.daily_time_utc, tzinfo=timezone.utc)
        if previous is not None and previous >= scheduled_at:
            scheduled_at += timedelta(days=1)
        elif current > scheduled_at:
            scheduled_at += timedelta(days=1)
        return scheduled_at
    if task.schedule_type == "weekly":
        if task.weekday_utc is None or task.weekly_time_utc is None:
            raise ValueError(f"weekday_utc and weekly_time_utc are required for task {task.name}")
        days_ahead = (task.weekday_utc - current.weekday()) % 7
        scheduled_date = current.date() + timedelta(days=days_ahead)
        scheduled_at = datetime.combine(scheduled_date, task.weekly_time_utc, tzinfo=timezone.utc)
        if previous is not None and previous >= scheduled_at:
            scheduled_at += timedelta(days=7)
        elif days_ahead == 0 and current > scheduled_at:
            scheduled_at += timedelta(days=7)
        return scheduled_at
    raise ValueError(f"Unsupported schedule type: {task.schedule_type}")


async def get_scheduler_status(*, now: datetime | None = None) -> list[dict]:
    current = now or datetime.now(timezone.utc)
    items: list[dict] = []
    for task in get_scheduled_tasks():
        last_run = await get_last_terminal_job_run(task.job_type)
        items.append({
            "name": task.name,
            "job_type": task.job_type,
            "title": task.title,
            "enabled": task.enabled,
            "schedule_type": task.schedule_type,
            "last_run_at": last_run,
            "next_run_at": next_task_run_at(task, current, last_run),
            "due_now": is_task_due(task, current, last_run) if task.enabled else False,
        })
    return items


def _is_interval_due(task: ScheduledTask, now: datetime, last_run: datetime | None) -> bool:
    if task.interval_seconds is None:
        raise ValueError(f"interval_seconds is required for task {task.name}")
    if last_run is None:
        return task.initial_delay_seconds <= 0
    return now >= last_run + timedelta(seconds=task.interval_seconds)


def _is_daily_due(task: ScheduledTask, now: datetime, last_run: datetime | None) -> bool:
    if task.daily_time_utc is None:
        raise ValueError(f"daily_time_utc is required for task {task.name}")
    scheduled_at = datetime.combine(now.date(), task.daily_time_utc, tzinfo=timezone.utc)
    if now < scheduled_at:
        return False
    if last_run is None:
        return True
    return last_run < scheduled_at


def _is_weekly_due(task: ScheduledTask, now: datetime, last_run: datetime | None) -> bool:
    if task.weekday_utc is None or task.weekly_time_utc is None:
        raise ValueError(f"weekday_utc and weekly_time_utc are required for task {task.name}")

    days_since_target = (now.weekday() - task.weekday_utc) % 7
    scheduled_date = now.date() - timedelta(days=days_since_target)
    scheduled_at = datetime.combine(scheduled_date, task.weekly_time_utc, tzinfo=timezone.utc)

    if now < scheduled_at:
        return False
    if last_run is None:
        return True
    return last_run < scheduled_at
