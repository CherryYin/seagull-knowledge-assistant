from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.web_directory import is_web_directory_discover_due, run_web_directory_discover_step


def make_source(source_id: str, metadata: dict | None = None):
    return SimpleNamespace(
        id=source_id,
        source_type="web",
        ingested_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        metadata_=metadata or {},
    )


class _ScalarRows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


def test_web_directory_discover_due_requires_opt_in_and_directory_flag():
    now = datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc)
    source = make_source(
        "src-1",
        {
            "web_directory": True,
            "auto_discover": True,
            "discover_interval_hours": 24,
            "last_auto_discovered_at": (now - timedelta(hours=25)).isoformat(),
        },
    )

    assert is_web_directory_discover_due(source, now=now) is True


def test_web_directory_discover_due_false_when_not_opted_in():
    source = make_source("src-1", {"web_directory": True, "auto_discover": False})
    assert is_web_directory_discover_due(source, now=datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc)) is False


@pytest.mark.asyncio
async def test_run_web_directory_discover_step_reports_no_due_sources():
    session = AsyncMock()
    session.execute.return_value = _ScalarRows([])
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with patch("pkg.services.foundation.web_directory.async_session", return_value=session_cm):
        result = await run_web_directory_discover_step()

    assert result["sources_due"] == 0
    assert result["reason"] == "no_due_web_directories"


@pytest.mark.asyncio
async def test_run_web_directory_discover_step_aggregates_results():
    due_source = make_source("src-1", {"web_directory": True, "auto_discover": True})
    list_session = AsyncMock()
    list_session.execute.return_value = _ScalarRows([due_source])
    worker_session = AsyncMock()
    worker_session.get.return_value = due_source
    sessions = [
        MagicMock(__aenter__=AsyncMock(return_value=list_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session), __aexit__=AsyncMock(return_value=None)),
    ]

    fake_result = SimpleNamespace(discovered=5, imported=3, updated=1, skipped=1)

    with (
        patch("pkg.services.foundation.web_directory.async_session", side_effect=sessions),
        patch("pkg.services.foundation.web_directory.import_web_directory_articles", AsyncMock(return_value=fake_result)),
        patch("pkg.services.foundation.web_directory.is_web_directory_discover_due", return_value=True),
    ):
        result = await run_web_directory_discover_step()

    assert result["sources_considered"] == 1
    assert result["sources_due"] == 1
    assert result["sources_processed"] == 1
    assert result["discovered"] == 5
    assert result["imported"] == 3
    assert result["updated"] == 1
    assert result["skipped"] == 1
    assert result["reason"] is None
