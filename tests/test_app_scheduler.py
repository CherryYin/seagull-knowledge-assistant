from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_lifespan_does_not_start_scheduler(monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)

    with (
        patch("pkg.api.app._enforce_admin_init_password_if_needed", AsyncMock()),
        patch("pkg.api.app.settings.JWT_SECRET_KEY", "x" * 32),
        patch("pkg.services.cross_cutting.scheduler.scheduled_pipeline_loop", AsyncMock()) as loop,
        patch(
            "pkg.services.cross_cutting.system_jobs.mark_stale_running_jobs_failed",
            AsyncMock(),
        ) as recover,
    ):
        from pkg.api.app import app, lifespan

        async with lifespan(app):
            pass

    loop.assert_not_awaited()
    recover.assert_not_awaited()
