import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from pkg.worker import run_worker


@pytest.mark.asyncio
async def test_worker_recovers_jobs_logs_disabled_tasks_and_starts_loop(caplog):
    caplog.set_level(logging.INFO, logger="pkg.worker")
    enabled_task = SimpleNamespace(name="maintenance_cleanup", enabled=True)
    disabled_task = SimpleNamespace(name="paper_discovery", enabled=False)

    with (
        patch("pkg.worker.mark_stale_running_jobs_failed", AsyncMock(return_value=2)) as recover,
        patch("pkg.worker.get_scheduled_tasks", return_value=[enabled_task, disabled_task]),
        patch("pkg.worker.scheduled_pipeline_loop", AsyncMock()) as loop,
    ):
        await run_worker(poll_interval_seconds=7)

    recover.assert_awaited_once_with()
    loop.assert_awaited_once_with(poll_interval_seconds=7)
    assert "Recovered 2 stale running system job(s)" in caplog.text
    assert "Scheduled task paper_discovery disabled." in caplog.text


@pytest.mark.asyncio
async def test_worker_continues_when_stale_job_recovery_fails(caplog):
    with (
        patch(
            "pkg.worker.mark_stale_running_jobs_failed",
            AsyncMock(side_effect=RuntimeError("database unavailable")),
        ),
        patch("pkg.worker.get_scheduled_tasks", return_value=[]),
        patch("pkg.worker.scheduled_pipeline_loop", AsyncMock()) as loop,
    ):
        await run_worker()

    loop.assert_awaited_once_with(poll_interval_seconds=30)
    assert "Failed to recover stale running system jobs" in caplog.text


@pytest.mark.asyncio
async def test_worker_honors_disable_environment(monkeypatch):
    monkeypatch.setenv("KG_DISABLE_BACKGROUND_TASKS", "true")

    with (
        patch("pkg.worker.mark_stale_running_jobs_failed", AsyncMock()) as recover,
        patch("pkg.worker.scheduled_pipeline_loop", AsyncMock()) as loop,
    ):
        await run_worker()

    recover.assert_not_awaited()
    loop.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_propagates_cancellation():
    with (
        patch("pkg.worker.mark_stale_running_jobs_failed", AsyncMock(return_value=0)),
        patch("pkg.worker.get_scheduled_tasks", return_value=[]),
        patch(
            "pkg.worker.scheduled_pipeline_loop",
            AsyncMock(side_effect=asyncio.CancelledError),
        ),
    ):
        with pytest.raises(asyncio.CancelledError):
            await run_worker()
