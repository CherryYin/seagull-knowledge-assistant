"""Tests for sources API endpoints (/sources/*)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# GET /sources/{source_id}
# ---------------------------------------------------------------------------
class TestGetSource:
    def test_found(self, client, mock_session, fake_user):
        source = _make_source("src-1", fake_user.id)
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        resp = client.get("/sources/src-1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "src-1"
        assert data["title"] == "Test Source"

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.get("/sources/nonexistent")
        assert resp.status_code == 404

    def test_wrong_user_not_shared(self, client, mock_session):
        source = _make_source("src-1", "other-user", is_shared=False)
        mock_session.get.return_value = source

        resp = client.get("/sources/src-1")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /sources (list)
# ---------------------------------------------------------------------------
class TestListSources:
    def test_empty(self, client, mock_session):
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [mock_count, mock_rows]

        resp = client.get("/sources")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []


# ---------------------------------------------------------------------------
# DELETE /sources/{source_id}
# ---------------------------------------------------------------------------
class TestDeleteSource:
    def test_success(self, client, mock_session, fake_user):
        source = _make_source("src-1", fake_user.id, file_path=None)
        # get calls: source, embedding
        mock_session.get.side_effect = [source, None]
        # execute for chunks query
        mock_chunks = MagicMock()
        mock_chunks.scalars.return_value = []
        mock_session.execute.return_value = mock_chunks

        resp = client.delete("/sources/src-1")
        assert resp.status_code == 204
        mock_session.commit.assert_awaited()

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.delete("/sources/nonexistent")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_source(source_id: str, user_id: str, is_shared: bool = False, file_path: str | None = None):
    source = MagicMock(spec=[])  # spec=[] prevents auto-attribute creation
    source.id = source_id
    source.user_id = user_id
    source.category_id = 1
    source.category_name = None
    source.title = "Test Source"
    source.source_type = "article"
    source.url = "https://example.com"
    source.raw_content = "Content"
    source.file_path = file_path
    source.content_hash = "abc123"
    source.metadata_ = {}
    source.is_shared = is_shared
    source.ingested_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    source.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    source.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return source

# ---------------------------------------------------------------------------
# RSS auto-discovery/list view helpers
# ---------------------------------------------------------------------------
class TestRssAutoDiscovery:
    @pytest.mark.asyncio
    async def test_maybe_enable_rss_for_source_marks_feed(self, mock_session):
        from pkg.api.sources import maybe_enable_rss_for_source

        source = _make_source("src-feed", "user-1")
        source.source_type = "web"
        source.url = "https://example.com"
        source.metadata_ = {}

        async def fake_discover(url):
            assert url == "https://example.com"
            return {
                "feed": MagicMock(),
                "feed_url": "https://example.com/feed",
                "feed_title": "Example Feed",
                "entries_available": 3,
            }

        from unittest.mock import patch, AsyncMock
        with patch("pkg.api.sources.discover_rss_feed", new=AsyncMock(side_effect=fake_discover)):
            enabled = await maybe_enable_rss_for_source(source, auto_fetch=False, session=mock_session)

        assert enabled is True
        assert source.url == "https://example.com/feed"
        assert source.metadata_["rss_enabled"] == "true"
        assert source.metadata_["feed_auto_detected"] is True

    @pytest.mark.asyncio
    async def test_maybe_enable_rss_for_source_records_not_found(self, mock_session):
        from pkg.api.sources import maybe_enable_rss_for_source
        from unittest.mock import patch, AsyncMock

        source = _make_source("src-web", "user-1")
        source.source_type = "web"
        source.url = "https://example.com/page"
        source.metadata_ = {}

        with patch("pkg.api.sources.discover_rss_feed", new=AsyncMock(return_value=None)):
            enabled = await maybe_enable_rss_for_source(source, auto_fetch=False, session=mock_session)

        assert enabled is False
        assert source.metadata_["rss_auto_discovery"] == "not_found"

    @pytest.mark.asyncio
    async def test_maybe_enable_rss_for_article_source_with_url(self, mock_session):
        from pkg.api.sources import maybe_enable_rss_for_source
        from unittest.mock import patch, AsyncMock

        source = _make_source("src-article", "user-1")
        source.source_type = "article"
        source.url = "https://example.com/blog"
        source.metadata_ = {}

        with patch("pkg.api.sources.discover_rss_feed", new=AsyncMock(return_value={
            "feed": MagicMock(),
            "feed_url": "https://example.com/blog/feed",
            "feed_title": "Blog Feed",
            "entries_available": 2,
        })):
            enabled = await maybe_enable_rss_for_source(source, auto_fetch=False, session=mock_session)

        assert enabled is True
        assert source.metadata_["rss_enabled"] == "true"
        assert source.url == "https://example.com/blog/feed"


@pytest.mark.asyncio
async def test_keep_imported_source_marks_reviewed_kept(mock_session, fake_user):
    from pkg.api.sources import keep_imported_source

    source = _make_source("src-imported", fake_user.id)
    source.metadata_ = {"review_status": "imported_reviewable", "connector": "github"}
    category = MagicMock()
    category.name = "General"
    mock_session.get.side_effect = [source, category]

    result = await keep_imported_source("src-imported", user=fake_user, session=mock_session)

    assert result.id == "src-imported"
    assert result.category_name == "General"
    assert source.metadata_["review_status"] == "reviewed_kept"
    assert source.metadata_["retention"] == "permanent"
    assert source.metadata_["reviewed_at"]
    assert source.metadata_["kept_at"]
    mock_session.commit.assert_awaited()
    mock_session.refresh.assert_awaited_with(source)


@pytest.mark.asyncio
async def test_keep_imported_source_not_found_for_other_user(mock_session, fake_user):
    from fastapi import HTTPException
    from pkg.api.sources import keep_imported_source

    source = _make_source("src-imported", "other-user")
    mock_session.get.return_value = source

    with pytest.raises(HTTPException) as exc:
        await keep_imported_source("src-imported", user=fake_user, session=mock_session)

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_keep_imported_source_rejects_non_reviewable_source(mock_session, fake_user):
    from fastapi import HTTPException
    from pkg.api.sources import keep_imported_source

    source = _make_source("src-normal", fake_user.id)
    source.metadata_ = {"review_status": "reviewed_kept"}
    mock_session.get.return_value = source

    with pytest.raises(HTTPException) as exc:
        await keep_imported_source("src-normal", user=fake_user, session=mock_session)

    assert exc.value.status_code == 409
