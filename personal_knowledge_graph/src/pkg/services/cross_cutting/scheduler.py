import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from time import perf_counter
from typing import AsyncIterator, Awaitable, Callable, Literal

from sqlalchemy import select, text

from pkg.config import settings
from pkg.db import async_session, engine
from pkg.models.user import User
from pkg.services.cross_cutting.system_jobs import record_system_job
from pkg.services.cross_cutting.system_jobs import get_last_terminal_job_runs
from pkg.services.cross_cutting.user_settings import get_user_setting_str


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
    timeout_seconds: int | None = settings.SCHEDULER_TASK_TIMEOUT_SECONDS
    retry_delay_seconds: int = settings.SCHEDULER_RETRY_DELAY_SECONDS
    jitter_seconds: int = 0
    initial_delay_seconds: int = 0


@dataclass(slots=True)
class TaskRunResult:
    status: Literal["completed", "failed", "skipped"]
    metadata: dict | None = None
    reason: str | None = None


def is_task_due(
    task: ScheduledTask,
    now: datetime,
    last_run: datetime | None,
    *,
    last_status: str | None = None,
    scheduler_started_at: datetime | None = None,
) -> bool:
    current = _ensure_utc(now)
    previous = _ensure_utc(last_run) if last_run else None

    if not task.enabled:
        return False

    if previous is not None and last_status == "failed":
        return current >= previous + timedelta(seconds=max(task.retry_delay_seconds, 0))

    if task.schedule_type == "interval":
        started_at = _ensure_utc(scheduler_started_at) if scheduler_started_at else None
        return _is_interval_due(task, current, previous, scheduler_started_at=started_at)
    if task.schedule_type == "daily":
        return _is_daily_due(task, current, previous)
    if task.schedule_type == "weekly":
        return _is_weekly_due(task, current, previous)
    raise ValueError(f"Unsupported schedule type: {task.schedule_type}")


@asynccontextmanager
async def acquire_task_lock(task_name: str) -> AsyncIterator[bool]:
    lock_key = int.from_bytes(
        hashlib.blake2b(task_name.encode("utf-8"), digest_size=8).digest(),
        byteorder="big",
        signed=True,
    )
    async with engine.connect() as connection:
        acquired = bool(
            (
                await connection.execute(
                    text("SELECT pg_try_advisory_lock(:lock_key)"),
                    {"lock_key": lock_key},
                )
            ).scalar()
        )
        await connection.commit()
        try:
            yield acquired
        finally:
            if acquired:
                try:
                    async def release_lock() -> None:
                        await connection.execute(
                            text("SELECT pg_advisory_unlock(:lock_key)"),
                            {"lock_key": lock_key},
                        )
                        await connection.commit()

                    await release_lock()
                except Exception:
                    logger.exception("Failed to release scheduler advisory lock for task %s", task_name)
                    await connection.invalidate()


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


async def run_maintenance_step() -> dict:
    from pkg.services.cross_cutting.maintenance import run_maintenance_cleanup_step

    return await run_maintenance_cleanup_step()


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
    from pkg.services.foundation.connector_trends import run_scheduled_github_trend_profiles

    stats = await run_scheduled_github_trend_profiles()
    if int(stats.get("runs", 0) or 0) == 0 and int(stats.get("failed", 0) or 0) > 0:
        raise RuntimeError("GitHub trend collection failed for all scheduled users or profiles")
    return dict(stats)


async def run_discovery_generate_step() -> dict:
    from pkg.services.foundation.discovery import generate_discovery_items

    async with async_session() as session:
        rows = await session.execute(select(User.id).where(User.is_active.is_(True)))
        user_ids = list(rows.scalars())

    totals = {
        "users": len(user_ids),
        "processed_users": 0,
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "errors": 0,
    }
    for user_id in user_ids:
        async with async_session() as session:
            try:
                created, updated, skipped = await generate_discovery_items(
                    session,
                    user_id=user_id,
                    limit=100,
                )
            except Exception:
                await session.rollback()
                totals["errors"] += 1
                logger.exception("Discovery generation failed for user %s", user_id)
                continue
            totals["processed_users"] += 1
            totals["created"] += created
            totals["updated"] += updated
            totals["skipped"] += skipped
    if totals["users"] > 0 and totals["processed_users"] == 0 and totals["errors"] > 0:
        raise RuntimeError("Discovery generation failed for all active users")
    totals["candidate_count"] = totals["created"] + totals["updated"] + totals["skipped"]
    totals["reason"] = None
    if totals["users"] == 0:
        totals["reason"] = "no_active_users"
    elif totals["errors"] > 0:
        totals["reason"] = "partial_failure"
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
    elif int(result.get("runs", 0) or 0) == 0 and int(result.get("errors", 0) or 0) > 0:
        raise RuntimeError("Paper discovery failed for all due profiles")
    elif int(result.get("errors", 0) or 0) > 0:
        result["reason"] = "partial_failure"
    return result


async def run_web_directory_discover_step() -> dict:
    from pkg.services.foundation.web_directory import run_web_directory_discover_step as run_step

    return await run_step()


async def run_web_refresh_step() -> dict:
    from pkg.services.foundation.web_extractor import run_web_refresh_step as run_step

    return await run_step()


def _parse_daily_time_utc(value: str, *, fallback: time) -> time:
    raw = (value or "").strip()
    if not raw:
        return fallback
    try:
        hour_text, minute_text = raw.split(":", 1)
        return time(hour=int(hour_text), minute=int(minute_text))
    except Exception:
        logger.warning("Invalid daily UTC time %r; fallback to %s", value, fallback.isoformat(timespec="minutes"))
        return fallback


async def run_news_auto_search_step() -> dict:
    from pkg.services.foundation.connectors import import_news_article, search_news_articles

    now = datetime.now(timezone.utc)
    window_hours = max(int(settings.NEWS_AUTO_SEARCH_WINDOW_HOURS or 24), 1)
    from_date = (now - timedelta(hours=window_hours)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    to_date = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    searches = [
        ("en", max(int(settings.NEWS_AUTO_SEARCH_EN_LIMIT or 20), 1)),
        ("zh", max(int(settings.NEWS_AUTO_SEARCH_ZH_LIMIT or 20), 1)),
    ]

    async with async_session() as session:
        rows = await session.execute(select(User.id).where(User.is_active.is_(True)))
        user_ids = list(rows.scalars())

    if not user_ids:
        return {
            "reason": "no_active_users",
            "query": settings.NEWS_AUTO_SEARCH_QUERY,
            "from_date": from_date,
            "to_date": to_date,
            "active_users": 0,
            "searched": 0,
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "errors": 0,
            "languages": {},
        }

    searched = 0
    created = 0
    updated = 0
    skipped = 0
    errors = 0
    attempted_searches = 0
    successful_searches = 0
    languages: dict[str, int] = {}

    for user_id in user_ids:
        try:
            async with async_session() as settings_session:
                query = await get_user_setting_str(
                    settings_session,
                    user_id,
                    "news_auto_search_query",
                    settings.NEWS_AUTO_SEARCH_QUERY,
                )
        except Exception:
            errors += 1
            logger.exception("News auto-search could not load settings for user %s", user_id)
            continue

        if not query:
            skipped += 1
            continue

        for language, limit in searches:
            attempted_searches += 1
            try:
                articles = await search_news_articles(
                    query=query,
                    language=language,
                    from_date=from_date,
                    to_date=to_date,
                    max_results=limit,
                    user_id=user_id,
                )
            except Exception:
                errors += 1
                logger.exception(
                    "News auto-search failed for user %s language %s",
                    user_id,
                    language,
                )
                continue
            successful_searches += 1
            languages[language] = languages.get(language, 0) + len(articles)
            searched += len(articles)

            for article in articles:
                async with async_session() as session:
                    try:
                        _, was_created, _ = await import_news_article(
                            session,
                            user_id=user_id,
                            article=article,
                            fetch_full_text=True,
                        )
                        await session.commit()
                    except ValueError:
                        await session.rollback()
                        skipped += 1
                        continue
                    except Exception:
                        await session.rollback()
                        errors += 1
                        logger.exception(
                            "News article import failed for user %s language %s",
                            user_id,
                            language,
                        )
                        continue

                if was_created:
                    created += 1
                else:
                    updated += 1

    if errors > 0 and (
        (successful_searches == 0 and skipped == 0)
        or (searched > 0 and created + updated == 0)
    ):
        raise RuntimeError("News auto-search failed before any result could be saved")

    reason = None if searched else "no_results"
    if errors > 0:
        reason = "partial_failure"
    return {
        "reason": reason,
        "query": settings.NEWS_AUTO_SEARCH_QUERY,
        "from_date": from_date,
        "to_date": to_date,
        "active_users": len(user_ids),
        "searched": searched,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "languages": languages,
    }


async def run_newsletter_automation_step() -> dict:
    from pkg.services.application.newsletter_automation import generate_newsletter

    async with async_session() as session:
        rows = await session.execute(select(User.id).where(User.is_active.is_(True)))
        user_ids = list(rows.scalars())

    generated = 0
    skipped = 0
    failed = 0
    asset_ids: list[str] = []
    for user_id in user_ids:
        async with async_session() as session:
            try:
                result = await generate_newsletter(session, user_id=user_id)
            except Exception:
                await session.rollback()
                failed += 1
                logger.exception("Newsletter automation failed for user %s", user_id)
                continue
        if result.status == "generated" and result.asset is not None:
            generated += 1
            asset_ids.append(result.asset.id)
        else:
            skipped += 1
    return {
        "active_users": len(user_ids),
        "generated": generated,
        "skipped": skipped,
        "failed": failed,
        "asset_ids": asset_ids,
    }


def get_scheduled_tasks() -> list[ScheduledTask]:
    tasks = [
        ScheduledTask(
            name="maintenance_cleanup",
            job_type="maintenance_cleanup",
            title="Maintenance cleanup",
            handler=run_maintenance_step,
            schedule_type="daily",
            daily_time_utc=time(hour=4, minute=0),
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
            name="connector_trends",
            job_type="connector_trends",
            title="GitHub trend profile collection",
            handler=run_connector_trends_step,
            schedule_type="interval",
            interval_seconds=settings.CONNECTOR_TRENDS_INTERVAL_HOURS * 3600,
            initial_delay_seconds=300,
            enabled=settings.CONNECTOR_TRENDS_AUTO_ENABLED,
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
        ScheduledTask(
            name="news_auto_search",
            job_type="news_auto_search",
            title="Scheduled news auto search",
            handler=run_news_auto_search_step,
            schedule_type="daily",
            daily_time_utc=_parse_daily_time_utc(settings.NEWS_AUTO_SEARCH_DAILY_TIME_UTC, fallback=time(hour=1, minute=30)),
            enabled=settings.NEWS_AUTO_SEARCH_ENABLED,
        ),
        ScheduledTask(
            name="newsletter_automation",
            job_type="newsletter_automation",
            title="Scheduled Newsletter Asset generation",
            handler=run_newsletter_automation_step,
            schedule_type="interval",
            interval_seconds=3600,
            initial_delay_seconds=120,
            enabled=True,
        ),
    ]
    return tasks


async def scheduled_pipeline_loop(
    *,
    poll_interval_seconds: int = 30,
    db_failure_backoff_seconds: int = settings.SCHEDULER_DB_FAILURE_BACKOFF_SECONDS,
) -> None:
    scheduler_started_at = datetime.now(timezone.utc)
    while True:
        now = datetime.now(timezone.utc)
        tasks = get_scheduled_tasks()
        try:
            last_runs = await get_last_terminal_job_runs([task.job_type for task in tasks])
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "Scheduled pipeline could not read job history; retrying after %s seconds",
                db_failure_backoff_seconds,
            )
            await asyncio.sleep(max(db_failure_backoff_seconds, poll_interval_seconds))
            continue

        for task in tasks:
            try:
                last_run = last_runs.get(task.job_type)
                if is_task_due(
                    task,
                    now,
                    last_run.ended_at if last_run else None,
                    last_status=last_run.status if last_run else None,
                    scheduler_started_at=scheduler_started_at,
                ):
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


def next_task_run_at(
    task: ScheduledTask,
    now: datetime,
    last_run: datetime | None,
    *,
    last_status: str | None = None,
    scheduler_started_at: datetime | None = None,
) -> datetime | None:
    current = _ensure_utc(now)
    previous = _ensure_utc(last_run) if last_run else None

    if not task.enabled:
        return None
    if previous is not None and last_status == "failed":
        return previous + timedelta(seconds=max(task.retry_delay_seconds, 0))
    if task.schedule_type == "interval":
        if task.interval_seconds is None:
            raise ValueError(f"interval_seconds is required for task {task.name}")
        if previous is None:
            started_at = _ensure_utc(scheduler_started_at) if scheduler_started_at else current
            return started_at + timedelta(seconds=max(task.initial_delay_seconds, 0))
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
    tasks = get_scheduled_tasks()
    last_runs = await get_last_terminal_job_runs([task.job_type for task in tasks])
    for task in tasks:
        last_run = last_runs.get(task.job_type)
        items.append({
            "name": task.name,
            "job_type": task.job_type,
            "title": task.title,
            "enabled": task.enabled,
            "schedule_type": task.schedule_type,
            "last_run_at": last_run.ended_at if last_run else None,
            "last_run_status": last_run.status if last_run else None,
            "next_run_at": next_task_run_at(
                task,
                current,
                last_run.ended_at if last_run else None,
                last_status=last_run.status if last_run else None,
            ),
            "due_now": is_task_due(
                task,
                current,
                last_run.ended_at if last_run else None,
                last_status=last_run.status if last_run else None,
            ) if task.enabled else False,
        })
    return items


def _is_interval_due(
    task: ScheduledTask,
    now: datetime,
    last_run: datetime | None,
    *,
    scheduler_started_at: datetime | None,
) -> bool:
    if task.interval_seconds is None:
        raise ValueError(f"interval_seconds is required for task {task.name}")
    if last_run is None:
        if task.initial_delay_seconds <= 0:
            return True
        if scheduler_started_at is None:
            return False
        return now >= scheduler_started_at + timedelta(seconds=task.initial_delay_seconds)
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
