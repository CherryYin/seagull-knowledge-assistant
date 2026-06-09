from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.system_job import SystemJob
from pkg.services.cross_cutting.system_jobs import list_system_jobs, record_system_event, sanitize_system_job


class _ScalarResult:
    def __init__(self, scalar=None, items=None):
        self._scalar = scalar
        self._items = items or []

    def scalar(self):
        return self._scalar

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_record_system_event_persists_completed_job_with_user_scope():
    session = AsyncMock()
    session.add = MagicMock()
    with patch("pkg.services.cross_cutting.system_jobs.async_session") as session_factory:
        session_factory.return_value.__aenter__.return_value = session
        job = await record_system_event(
            user_id="user-1",
            job_type="test_job",
            title="Test job",
            status="completed",
            metadata={"ok": True},
            duration_ms=12.3,
        )

    assert job.user_id == "user-1"
    assert job.job_type == "test_job"
    assert job.status == "completed"
    assert job.metadata_ == {"ok": True}
    session.add.assert_called_once_with(job)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_list_system_jobs_filters_to_current_user_by_default():
    db = AsyncMock()
    job = SystemJob(user_id="user-1", job_type="rss_fetch", status="completed", title="RSS fetch")
    db.execute.side_effect = [_ScalarResult(scalar=1), _ScalarResult(items=[job])]

    items, total = await list_system_jobs(db, user_id="user-1", job_type="rss_fetch", status="completed")

    assert total == 1
    assert items == [job]
    executed_sql = str(db.execute.call_args_list[0].args[0])
    assert "system_jobs.user_id" in executed_sql


@pytest.mark.asyncio
async def test_list_system_jobs_admin_scope_can_include_all_users():
    db = AsyncMock()
    job = SystemJob(user_id="user-2", job_type="rss_fetch", status="failed", title="RSS fetch")
    db.execute.side_effect = [_ScalarResult(scalar=1), _ScalarResult(items=[job])]

    items, total = await list_system_jobs(db, user_id="admin-1", include_all_users=True, status="failed")

    assert total == 1
    assert items == [job]
    executed_sql = str(db.execute.call_args_list[0].args[0])
    assert "system_jobs.user_id" not in executed_sql


@pytest.mark.asyncio
async def test_system_jobs_api_non_admin_cannot_request_all_scope(fake_user, mock_session, monkeypatch):
    from pkg.api import system_jobs as system_jobs_api

    captured = {}

    async def fake_list_system_jobs(db, **kwargs):
        captured.update(kwargs)
        return [], 0

    monkeypatch.setattr(system_jobs_api, "list_system_jobs", fake_list_system_jobs)

    result = await system_jobs_api.get_system_jobs(scope="all", user=fake_user, db=mock_session)

    assert result.total == 0
    assert captured["user_id"] == "test-user-001"
    assert captured["include_all_users"] is False


@pytest.mark.asyncio
async def test_system_jobs_api_admin_can_request_all_scope(fake_admin, mock_session, monkeypatch):
    from pkg.api import system_jobs as system_jobs_api

    captured = {}

    async def fake_list_system_jobs(db, **kwargs):
        captured.update(kwargs)
        return [], 0

    monkeypatch.setattr(system_jobs_api, "list_system_jobs", fake_list_system_jobs)

    result = await system_jobs_api.get_system_jobs(scope="all", user=fake_admin, db=mock_session)

    assert result.total == 0
    assert captured["include_all_users"] is True


def test_sanitize_system_job_hides_sensitive_fields_for_non_admins():
    job = SystemJob(
        user_id="user-1",
        job_type="rss_fetch",
        status="failed",
        title="RSS fetch",
        detail="secret stack trace detail",
        metadata_={"token": "secret"},
        error_message="x" * 200,
    )

    sanitized = sanitize_system_job(job, include_sensitive=False)

    assert sanitized.detail is None
    assert sanitized.metadata_ is None
    assert sanitized.error_message.endswith("...")
    assert len(sanitized.error_message) == 160
