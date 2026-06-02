from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.system_job import SystemJob
from pkg.services.system_jobs import list_system_jobs, record_system_event


class _ScalarResult:
    def __init__(self, scalar=None, items=None):
        self._scalar = scalar
        self._items = items or []

    def scalar(self):
        return self._scalar

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_record_system_event_persists_completed_job():
    session = AsyncMock()
    session.add = MagicMock()
    with patch("pkg.services.system_jobs.async_session") as session_factory:
        session_factory.return_value.__aenter__.return_value = session
        job = await record_system_event(
            job_type="test_job",
            title="Test job",
            status="completed",
            metadata={"ok": True},
            duration_ms=12.3,
        )

    assert job.job_type == "test_job"
    assert job.status == "completed"
    assert job.metadata_ == {"ok": True}
    session.add.assert_called_once_with(job)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_list_system_jobs_filters_and_counts():
    db = AsyncMock()
    job = SystemJob(job_type="rss_fetch", status="completed", title="RSS fetch")
    db.execute.side_effect = [_ScalarResult(scalar=1), _ScalarResult(items=[job])]

    items, total = await list_system_jobs(db, job_type="rss_fetch", status="completed")

    assert total == 1
    assert items == [job]
