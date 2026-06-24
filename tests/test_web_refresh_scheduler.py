from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.web_extractor import is_web_refresh_due, run_web_refresh_step


def make_source(source_id: str, metadata: dict | None = None, *, url: str | None = "https://example.com/post"):
    return SimpleNamespace(
        id=source_id,
        source_type="web",
        url=url,
        title="Example",
        content_hash="old-hash",
        ingested_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        metadata_=metadata or {},
    )


class _ScalarRows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


def test_web_refresh_due_requires_opt_in_and_non_directory_source():
    now = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)
    source = make_source(
        "src-1",
        {
            "auto_refresh": True,
            "refresh_interval_days": 7,
            "last_checked_at": (now - timedelta(days=8)).isoformat(),
        },
    )
    assert is_web_refresh_due(source, now=now) is True


def test_web_refresh_due_false_for_directory_source():
    source = make_source("src-1", {"auto_refresh": True, "web_directory": True})
    assert is_web_refresh_due(source, now=datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)) is False


@pytest.mark.asyncio
async def test_run_web_refresh_step_reports_no_due_sources():
    session = AsyncMock()
    session.execute.return_value = _ScalarRows([])
    session_cm = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with patch("pkg.services.foundation.web_extractor.async_session", return_value=session_cm):
        result = await run_web_refresh_step()

    assert result["sources_due"] == 0
    assert result["reason"] == "no_due_web_sources"


@pytest.mark.asyncio
async def test_run_web_refresh_step_reports_unchanged_content():
    due_source = make_source("src-1", {"auto_refresh": True})
    list_session = AsyncMock()
    list_session.execute.return_value = _ScalarRows([due_source])
    worker_session = AsyncMock()
    worker_session.get.return_value = due_source
    sessions = [
        MagicMock(__aenter__=AsyncMock(return_value=list_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session), __aexit__=AsyncMock(return_value=None)),
    ]
    page = SimpleNamespace(title="Example", final_url="https://example.com/post", text="old text", metadata={})

    with (
        patch("pkg.services.foundation.web_extractor.async_session", side_effect=sessions),
        patch("pkg.services.foundation.web_extractor.is_web_refresh_due", return_value=True),
        patch("pkg.services.foundation.web_extractor.fetch_web_page", AsyncMock(return_value=page)),
        patch("pkg.services.foundation.web_extractor.hashlib.sha256") as mock_sha,
    ):
        mock_sha.return_value.hexdigest.return_value = "old-hash"
        result = await run_web_refresh_step()

    assert result["sources_checked"] == 1
    assert result["sources_unchanged"] == 1
    assert result["reason"] == "no_web_content_changes"


@pytest.mark.asyncio
async def test_run_web_refresh_step_reports_refreshed_content():
    due_source = make_source("src-1", {"auto_refresh": True})
    list_session = AsyncMock()
    list_session.execute.return_value = _ScalarRows([due_source])
    worker_session = AsyncMock()
    worker_session.get.return_value = due_source
    sessions = [
        MagicMock(__aenter__=AsyncMock(return_value=list_session), __aexit__=AsyncMock(return_value=None)),
        MagicMock(__aenter__=AsyncMock(return_value=worker_session), __aexit__=AsyncMock(return_value=None)),
    ]
    page = SimpleNamespace(title="Updated", final_url="https://example.com/post", text="new text", metadata={"web_fetch_updated_at": "2026-06-15T00:00:00+00:00"})

    with (
        patch("pkg.services.foundation.web_extractor.async_session", side_effect=sessions),
        patch("pkg.services.foundation.web_extractor.is_web_refresh_due", return_value=True),
        patch("pkg.services.foundation.web_extractor.fetch_web_page", AsyncMock(return_value=page)),
        patch("pkg.services.foundation.web_extractor.hashlib.sha256") as mock_sha,
        patch("pkg.services.foundation.rss_fetcher._update_source_content", AsyncMock()),
    ):
        mock_sha.return_value.hexdigest.return_value = "new-hash"
        result = await run_web_refresh_step()

    assert result["sources_checked"] == 1
    assert result["sources_refreshed"] == 1
    assert result["reason"] is None
