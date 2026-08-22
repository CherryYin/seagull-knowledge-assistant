import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, time, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.scheduler import (
    ScheduledTask,
    TaskRunResult,
    get_scheduler_status,
    get_scheduled_tasks,
    is_task_due,
    next_task_run_at,
    run_discovery_generate_step,
    run_maintenance_step,
    run_news_auto_search_step,
    run_paper_discovery_step,
    run_rss_fetch_step,
    run_rss_summary_step,
    run_scheduled_task,
    run_user_profiler_step,
)


async def _noop():
    return None


def test_interval_task_not_due_before_interval_passes():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=_noop,
        schedule_type="interval",
        interval_seconds=3600,
    )

    now = datetime(2026, 6, 13, 10, 0, tzinfo=timezone.utc)
    last_run = datetime(2026, 6, 13, 9, 30, tzinfo=timezone.utc)

    assert is_task_due(task, now, last_run) is False


def test_interval_task_due_after_interval_passes():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=_noop,
        schedule_type="interval",
        interval_seconds=3600,
    )

    now = datetime(2026, 6, 13, 10, 30, tzinfo=timezone.utc)
    last_run = datetime(2026, 6, 13, 9, 0, tzinfo=timezone.utc)

    assert is_task_due(task, now, last_run) is True


def test_interval_task_respects_initial_delay_on_first_run():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=_noop,
        schedule_type="interval",
        interval_seconds=3600,
        initial_delay_seconds=60,
    )

    now = datetime(2026, 6, 13, 10, 0, tzinfo=timezone.utc)

    assert is_task_due(task, now, None) is False


def test_daily_task_runs_once_after_scheduled_time():
    task = ScheduledTask(
        name="daily_summarizer",
        job_type="daily_summarizer",
        title="Daily summarizer",
        handler=_noop,
        schedule_type="daily",
        daily_time_utc=time(hour=2, minute=0),
    )

    now = datetime(2026, 6, 13, 3, 0, tzinfo=timezone.utc)
    last_run = datetime(2026, 6, 12, 2, 0, tzinfo=timezone.utc)

    assert is_task_due(task, now, last_run) is True


def test_daily_task_not_due_before_scheduled_time():
    task = ScheduledTask(
        name="daily_summarizer",
        job_type="daily_summarizer",
        title="Daily summarizer",
        handler=_noop,
        schedule_type="daily",
        daily_time_utc=time(hour=2, minute=0),
    )

    now = datetime(2026, 6, 13, 1, 59, tzinfo=timezone.utc)

    assert is_task_due(task, now, None) is False


def test_daily_task_not_due_twice_same_day():
    task = ScheduledTask(
        name="daily_summarizer",
        job_type="daily_summarizer",
        title="Daily summarizer",
        handler=_noop,
        schedule_type="daily",
        daily_time_utc=time(hour=2, minute=0),
    )

    now = datetime(2026, 6, 13, 4, 0, tzinfo=timezone.utc)
    last_run = datetime(2026, 6, 13, 2, 1, tzinfo=timezone.utc)

    assert is_task_due(task, now, last_run) is False


def test_weekly_task_runs_once_after_weekday_time():
    task = ScheduledTask(
        name="user_profiler",
        job_type="user_profiler",
        title="Weekly user profiling",
        handler=_noop,
        schedule_type="weekly",
        weekday_utc=0,
        weekly_time_utc=time(hour=3, minute=0),
    )

    now = datetime(2026, 6, 15, 4, 0, tzinfo=timezone.utc)  # Monday
    last_run = datetime(2026, 6, 8, 3, 0, tzinfo=timezone.utc)

    assert is_task_due(task, now, last_run) is True


def test_weekly_task_not_due_before_target_time_same_day():
    task = ScheduledTask(
        name="user_profiler",
        job_type="user_profiler",
        title="Weekly user profiling",
        handler=_noop,
        schedule_type="weekly",
        weekday_utc=0,
        weekly_time_utc=time(hour=3, minute=0),
    )

    now = datetime(2026, 6, 15, 2, 59, tzinfo=timezone.utc)  # Monday

    assert is_task_due(task, now, None) is False


def test_weekly_task_not_due_twice_same_week():
    task = ScheduledTask(
        name="user_profiler",
        job_type="user_profiler",
        title="Weekly user profiling",
        handler=_noop,
        schedule_type="weekly",
        weekday_utc=0,
        weekly_time_utc=time(hour=3, minute=0),
    )

    now = datetime(2026, 6, 17, 8, 0, tzinfo=timezone.utc)  # Wednesday
    last_run = datetime(2026, 6, 15, 3, 5, tzinfo=timezone.utc)

    assert is_task_due(task, now, last_run) is False


def test_disabled_task_is_never_due():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=_noop,
        schedule_type="interval",
        interval_seconds=3600,
        enabled=False,
    )

    assert is_task_due(task, datetime(2026, 6, 13, 10, 0, tzinfo=timezone.utc), None) is False


def test_interval_task_requires_interval_seconds():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=_noop,
        schedule_type="interval",
    )

    with pytest.raises(ValueError, match="interval_seconds"):
        is_task_due(task, datetime(2026, 6, 13, 10, 0, tzinfo=timezone.utc), None)


@pytest.mark.asyncio
async def test_run_scheduled_task_records_completed_metadata():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=AsyncMock(return_value={"created": 3}),
        schedule_type="interval",
        interval_seconds=3600,
    )

    job = MagicMock()

    @asynccontextmanager
    async def fake_record_system_job(**kwargs):
        yield job

    with patch("pkg.services.cross_cutting.scheduler.record_system_job", fake_record_system_job):
        result = await run_scheduled_task(task)

    assert result == TaskRunResult(status="completed", metadata={"created": 3}, reason=None)
    assert job.metadata_ == {"created": 3}


@pytest.mark.asyncio
async def test_run_scheduled_task_skips_when_lock_not_acquired():
    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=AsyncMock(return_value={"created": 3}),
        schedule_type="interval",
        interval_seconds=3600,
    )

    @asynccontextmanager
    async def fake_lock(task_name: str):
        yield False

    with patch("pkg.services.cross_cutting.scheduler.acquire_task_lock", fake_lock):
        result = await run_scheduled_task(task)

    assert result.status == "skipped"
    assert result.reason == "lock_not_acquired"


@pytest.mark.asyncio
async def test_run_scheduled_task_returns_failed_on_timeout():
    async def slow_handler():
        await asyncio.sleep(0.05)
        return {"ok": True}

    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=slow_handler,
        schedule_type="interval",
        interval_seconds=3600,
        timeout_seconds=0.001,
    )

    job = MagicMock()

    @asynccontextmanager
    async def fake_record_system_job(**kwargs):
        yield job

    with patch("pkg.services.cross_cutting.scheduler.record_system_job", fake_record_system_job):
        result = await run_scheduled_task(task)

    assert result.status == "failed"
    assert "timed out" in (result.reason or "")
    assert job.metadata_ == {"reason": "timeout", "timeout_seconds": 0.001}


@pytest.mark.asyncio
async def test_run_scheduled_task_propagates_cancellation():
    async def cancelled_handler():
        raise asyncio.CancelledError()

    task = ScheduledTask(
        name="rss_fetch",
        job_type="rss_fetch",
        title="RSS fetch",
        handler=cancelled_handler,
        schedule_type="interval",
        interval_seconds=3600,
    )

    @asynccontextmanager
    async def fake_record_system_job(**kwargs):
        yield MagicMock()

    with patch("pkg.services.cross_cutting.scheduler.record_system_job", fake_record_system_job):
        with pytest.raises(asyncio.CancelledError):
            await run_scheduled_task(task)


@pytest.mark.asyncio
async def test_run_rss_fetch_step_reports_no_enabled_feeds_reason():
    with (
        patch("pkg.services.foundation.rss_fetcher.fetch_all_feeds", AsyncMock(return_value={"feeds_checked": 0, "new_articles": 0, "errors": 0})),
        patch("pkg.services.foundation.rss_fetcher.cleanup_old_rss_articles", AsyncMock(return_value=0)),
    ):
        result = await run_rss_fetch_step()

    assert result["feeds_checked"] == 0
    assert result["new_articles"] == 0
    assert result["reason"] == "no_rss_enabled_feeds"


@pytest.mark.asyncio
async def test_run_rss_fetch_step_reports_no_new_articles_reason():
    with (
        patch("pkg.services.foundation.rss_fetcher.fetch_all_feeds", AsyncMock(return_value={"feeds_checked": 3, "new_articles": 0, "errors": 0})),
        patch("pkg.services.foundation.rss_fetcher.cleanup_old_rss_articles", AsyncMock(return_value=2)),
    ):
        result = await run_rss_fetch_step()

    assert result["deleted"] == 2
    assert result["reason"] == "no_new_rss_articles"


@pytest.mark.asyncio
async def test_run_rss_summary_step_reports_no_recent_articles_reason():
    with patch("pkg.services.foundation.rss_summarizer.summarize_rss_by_topic", AsyncMock(return_value=[])):
        result = await run_rss_summary_step()

    assert result["created"] == 0
    assert result["reason"] == "no_recent_rss_articles"


@pytest.mark.asyncio
async def test_run_rss_summary_step_reports_created_note_ids():
    with patch("pkg.services.foundation.rss_summarizer.summarize_rss_by_topic", AsyncMock(return_value=["note-1", "note-2"])):
        result = await run_rss_summary_step()

    assert result["created"] == 2
    assert result["note_ids"] == ["note-1", "note-2"]
    assert result["reason"] is None


class _ScalarRows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_run_user_profiler_step_reports_no_active_users_reason():
    session = AsyncMock()
    session.execute.return_value = _ScalarRows([])
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm),
        patch("pkg.services.cross_cutting.user_profiler.profile_all_users", AsyncMock(return_value=0)),
    ):
        result = await run_user_profiler_step()

    assert result["active_users"] == 0
    assert result["profiled"] == 0
    assert result["skipped"] == 0
    assert result["reason"] == "no_active_users"


@pytest.mark.asyncio
async def test_run_user_profiler_step_reports_profile_counts():
    session = AsyncMock()
    session.execute.return_value = _ScalarRows(["user-1", "user-2", "user-3"])
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm),
        patch("pkg.services.cross_cutting.user_profiler.profile_all_users", AsyncMock(return_value=2)),
    ):
        result = await run_user_profiler_step()

    assert result["active_users"] == 3
    assert result["profiled"] == 2
    assert result["skipped"] == 1
    assert result["reason"] is None


@pytest.mark.asyncio
async def test_run_discovery_generate_step_reports_no_active_users_reason():
    session = AsyncMock()
    session.execute.return_value = _ScalarRows([])
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm):
        result = await run_discovery_generate_step()

    assert result["users"] == 0
    assert result["candidate_count"] == 0
    assert result["reason"] == "no_active_users"


@pytest.mark.asyncio
async def test_run_discovery_generate_step_reports_no_candidates_reason():
    user_lookup_session = AsyncMock()
    user_lookup_session.execute.return_value = _ScalarRows(["user-1", "user-2"])
    worker_session_1 = AsyncMock()
    worker_session_2 = AsyncMock()
    sessions = [
        MagicMock(__aenter__=AsyncMock(return_value=user_lookup_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session_1), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session_2), __aexit__=AsyncMock(return_value=None)),
    ]

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", side_effect=sessions),
        patch("pkg.services.foundation.discovery.generate_discovery_items", AsyncMock(side_effect=[(0, 0, 0), (0, 0, 0)])),
    ):
        result = await run_discovery_generate_step()

    assert result["users"] == 2
    assert result["candidate_count"] == 0
    assert result["reason"] == "no_recent_rss_articles_or_connector_candidates"


@pytest.mark.asyncio
async def test_run_discovery_generate_step_reports_candidate_counts():
    user_lookup_session = AsyncMock()
    user_lookup_session.execute.return_value = _ScalarRows(["user-1"])
    worker_session = AsyncMock()
    sessions = [
        MagicMock(__aenter__=AsyncMock(return_value=user_lookup_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session), __aexit__=AsyncMock(return_value=None)),
    ]

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", side_effect=sessions),
        patch("pkg.services.foundation.discovery.generate_discovery_items", AsyncMock(return_value=(2, 1, 3))),
    ):
        result = await run_discovery_generate_step()

    assert result["users"] == 1
    assert result["created"] == 2
    assert result["updated"] == 1
    assert result["skipped"] == 3
    assert result["candidate_count"] == 6
    assert result["reason"] is None


@pytest.mark.asyncio
async def test_run_maintenance_step_delegates_to_cleanup_service():
    cleanup = AsyncMock(return_value={"expired_digest_notes_deleted": 4})
    with patch("pkg.services.cross_cutting.maintenance.run_maintenance_cleanup_step", cleanup):
        result = await run_maintenance_step()

    assert result == {"expired_digest_notes_deleted": 4}
    cleanup.assert_awaited_once_with()


def test_get_scheduled_tasks_includes_daily_maintenance_cleanup():
    task = next(task for task in get_scheduled_tasks() if task.name == "maintenance_cleanup")

    assert task.handler is run_maintenance_step
    assert task.schedule_type == "daily"
    assert task.daily_time_utc == time(hour=4, minute=0)


def test_get_scheduled_tasks_excludes_legacy_daily_summarizer():
    assert all(task.name != "daily_summarizer" for task in get_scheduled_tasks())


@pytest.mark.asyncio
async def test_run_paper_discovery_step_reports_no_enabled_profiles_reason():
    session = AsyncMock()
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm),
        patch("pkg.services.foundation.paper_discovery_jobs.run_scheduled_paper_discovery_profiles", AsyncMock(return_value={"profiles": 0, "eligible": 0, "runs": 0, "created": 0, "updated": 0})),
    ):
        result = await run_paper_discovery_step()

    assert result["reason"] == "no_enabled_profiles"


@pytest.mark.asyncio
async def test_run_paper_discovery_step_reports_no_due_profiles_reason():
    session = AsyncMock()
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm),
        patch("pkg.services.foundation.paper_discovery_jobs.run_scheduled_paper_discovery_profiles", AsyncMock(return_value={"profiles": 3, "eligible": 0, "runs": 0, "created": 0, "updated": 0})),
    ):
        result = await run_paper_discovery_step()

    assert result["reason"] == "no_due_profiles"


@pytest.mark.asyncio
async def test_run_paper_discovery_step_reports_stats_without_reason_when_runs_exist():
    session = AsyncMock()
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm),
        patch("pkg.services.foundation.paper_discovery_jobs.run_scheduled_paper_discovery_profiles", AsyncMock(return_value={"profiles": 3, "eligible": 2, "runs": 2, "created": 5, "updated": 1})),
    ):
        result = await run_paper_discovery_step()

    assert result["profiles"] == 3
    assert result["runs"] == 2
    assert result["created"] == 5
    assert result["updated"] == 1
    assert result["reason"] is None


def test_get_scheduled_tasks_includes_news_auto_search_when_enabled(monkeypatch):
    monkeypatch.setattr("pkg.services.cross_cutting.scheduler.settings.NEWS_AUTO_SEARCH_ENABLED", True)
    monkeypatch.setattr("pkg.services.cross_cutting.scheduler.settings.NEWS_AUTO_SEARCH_DAILY_TIME_UTC", "05:45")

    tasks = get_scheduled_tasks()
    task = next(task for task in tasks if task.name == "news_auto_search")

    assert task.enabled is True
    assert task.schedule_type == "daily"
    assert task.daily_time_utc == time(hour=5, minute=45)


@pytest.mark.asyncio
async def test_run_news_auto_search_step_reports_no_active_users():
    user_lookup_session = AsyncMock()
    user_lookup_session.execute.return_value = _ScalarRows([])
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=user_lookup_session), __aexit__=AsyncMock(return_value=None))

    with patch("pkg.services.cross_cutting.scheduler.async_session", return_value=session_cm):
        result = await run_news_auto_search_step()

    assert result["reason"] == "no_active_users"
    assert result["active_users"] == 0
    assert result["searched"] == 0


@pytest.mark.asyncio
async def test_run_news_auto_search_step_searches_en_and_zh_and_imports_articles():
    class _Article:
        def __init__(self, title: str, language: str):
            self.title = title
            self.language = language

    user_lookup_session = AsyncMock()
    user_lookup_session.execute.return_value = _ScalarRows(["user-1"])
    worker_session_1 = AsyncMock()
    worker_session_2 = AsyncMock()
    worker_session_3 = AsyncMock()
    settings_session = AsyncMock()
    sessions = [
        MagicMock(__aenter__=AsyncMock(return_value=user_lookup_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=settings_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session_1), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session_2), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session_3), __aexit__=AsyncMock(return_value=None)),
    ]

    search_mock = AsyncMock(side_effect=[[_Article("en-a", "en")], [_Article("zh-a", "zh"), _Article("zh-b", "zh")]])
    import_mock = AsyncMock(side_effect=[(object(), True, "a"), (object(), False, "b"), (object(), True, "c")])

    with (
        patch("pkg.services.cross_cutting.scheduler.async_session", side_effect=sessions),
        patch("pkg.services.cross_cutting.scheduler.get_user_setting_str", AsyncMock(return_value="custom news query")),
        patch("pkg.services.foundation.connectors.search_news_articles", search_mock),
        patch("pkg.services.foundation.connectors.import_news_article", import_mock),
        patch("pkg.services.cross_cutting.scheduler.settings.NEWS_AUTO_SEARCH_QUERY", "AI, LLM, Agent, workflow"),
        patch("pkg.services.cross_cutting.scheduler.settings.NEWS_AUTO_SEARCH_WINDOW_HOURS", 24),
        patch("pkg.services.cross_cutting.scheduler.settings.NEWS_AUTO_SEARCH_EN_LIMIT", 20),
        patch("pkg.services.cross_cutting.scheduler.settings.NEWS_AUTO_SEARCH_ZH_LIMIT", 20),
    ):
        result = await run_news_auto_search_step()

    assert search_mock.await_count == 2
    assert search_mock.await_args_list[0].kwargs["query"] == "custom news query"
    assert import_mock.await_count == 3
    assert result["searched"] == 3
    assert result["created"] == 2
    assert result["updated"] == 1
    assert result["languages"] == {"en": 1, "zh": 2}
    assert result["reason"] is None


def test_next_task_run_at_for_daily_task_after_run_today():
    task = ScheduledTask(
        name="daily_summarizer",
        job_type="daily_summarizer",
        title="Daily summarizer",
        handler=_noop,
        schedule_type="daily",
        daily_time_utc=time(hour=2, minute=0),
    )

    now = datetime(2026, 6, 15, 3, 0, tzinfo=timezone.utc)
    last_run = datetime(2026, 6, 15, 2, 5, tzinfo=timezone.utc)

    assert next_task_run_at(task, now, last_run) == datetime(2026, 6, 16, 2, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_get_scheduler_status_reports_enabled_and_next_run():
    now = datetime(2026, 6, 15, 3, 0, tzinfo=timezone.utc)
    task = ScheduledTask(
        name="daily_summarizer",
        job_type="daily_summarizer",
        title="Daily summarizer",
        handler=_noop,
        schedule_type="daily",
        daily_time_utc=time(hour=2, minute=0),
    )

    with (
        patch("pkg.services.cross_cutting.scheduler.get_scheduled_tasks", return_value=[task]),
        patch("pkg.services.cross_cutting.scheduler.get_last_terminal_job_run", AsyncMock(return_value=datetime(2026, 6, 14, 2, 0, tzinfo=timezone.utc))),
    ):
        items = await get_scheduler_status(now=now)

    assert len(items) == 1
    assert items[0]["name"] == "daily_summarizer"
    assert items[0]["enabled"] is True
    assert items[0]["due_now"] is True
    assert items[0]["next_run_at"] == datetime(2026, 6, 16, 2, 0, tzinfo=timezone.utc)
