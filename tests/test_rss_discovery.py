from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.rss_discovery import discover_rss_for_web_sources


@pytest.mark.asyncio
async def test_discover_rss_for_web_sources_enables_found_feed():
    source = _make_web_source("src-1")
    rows = MagicMock()
    rows.scalars.return_value = [source]

    session = AsyncMock()
    session.execute = AsyncMock(return_value=rows)
    session.commit = AsyncMock()

    async def fake_enable(source_arg, *, auto_fetch, session):
        assert source_arg is source
        assert auto_fetch is False
        source_arg.metadata_ = {"rss_enabled": "true", "feed_url": "https://example.com/feed"}
        return True

    with patch("pkg.api.sources.maybe_enable_rss_for_source", new=AsyncMock(side_effect=fake_enable)):
        stats = await discover_rss_for_web_sources(session, limit=10)

    assert stats == {"candidates": 1, "enabled": 1, "not_found": 0, "skipped": 0, "failed": 0}
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_discover_rss_for_web_sources_counts_not_found():
    source = _make_web_source("src-1")
    rows = MagicMock()
    rows.scalars.return_value = [source]

    session = AsyncMock()
    session.execute = AsyncMock(return_value=rows)
    session.commit = AsyncMock()

    with patch("pkg.api.sources.maybe_enable_rss_for_source", new=AsyncMock(return_value=False)):
        stats = await discover_rss_for_web_sources(session)

    assert stats["not_found"] == 1
    assert stats["enabled"] == 0
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_discover_rss_for_web_sources_dry_run_does_not_commit():
    source = _make_web_source("src-1")
    rows = MagicMock()
    rows.scalars.return_value = [source]

    session = AsyncMock()
    session.execute = AsyncMock(return_value=rows)
    session.commit = AsyncMock()

    with patch("pkg.api.sources.maybe_enable_rss_for_source", new=AsyncMock()) as mock_enable:
        stats = await discover_rss_for_web_sources(session, dry_run=True)

    assert stats["candidates"] == 1
    mock_enable.assert_not_called()
    session.commit.assert_not_awaited()


def _make_web_source(source_id: str):
    source = MagicMock(spec=[])
    source.id = source_id
    source.user_id = "user-1"
    source.source_type = "web"
    source.url = "https://example.com"
    source.metadata_ = {}
    source.ingested_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return source


def test_discovery_query_includes_article_sources():
    from sqlalchemy.dialects import postgresql
    from sqlalchemy import select, text
    from pkg.models.source import Source

    stmt = select(Source).where(
        Source.source_type.in_(["web", "article"]),
        Source.user_id.is_not(None),
        Source.url.is_not(None),
        text("COALESCE(metadata->>'rss_enabled', '') <> 'true'"),
        text("NOT (metadata ? 'feed_source_id')"),
    )
    compiled = str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "'web', 'article'" in compiled
