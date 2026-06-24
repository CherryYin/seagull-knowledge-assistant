from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_lifespan_starts_single_scheduler_task(monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("KG_DISABLE_BACKGROUND_TASKS", raising=False)

    with (
        patch("pkg.api.app._enforce_admin_init_password_if_needed", AsyncMock()),
        patch("pkg.api.app.settings.JWT_SECRET_KEY", "x" * 32),
        patch("pkg.services.cross_cutting.system_jobs.mark_stale_running_jobs_failed", AsyncMock(return_value=0)),
        patch("pkg.services.cross_cutting.scheduler.get_scheduled_tasks", return_value=[]),
        patch("pkg.services.cross_cutting.scheduler.scheduled_pipeline_loop", AsyncMock()),
        patch("pkg.api.app.asyncio.create_task") as mock_create_task,
    ):
        from pkg.api.app import app, lifespan

        task = MagicMock()
        mock_create_task.return_value = task

        async with lifespan(app):
            pass

    mock_create_task.assert_called_once()
    task.cancel.assert_called_once()
