"""Tests for sources API endpoints (/sources/*)."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

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
# POST /sources
# ---------------------------------------------------------------------------
class TestCreateSource:
    def test_make_source_id_slugifies_url_title(self):
        from pkg.api.sources import make_source_id

        source_id = make_source_id("https://claude.com/blog/introducing-dynamic-workflows-in-claude-code")

        assert source_id.startswith("src-")
        assert ":" not in source_id
        assert "/" not in source_id
        assert "claude-com-blog-introducing" in source_id

    @pytest.mark.asyncio
    async def test_web_url_without_content_fetches_page(self, mock_session, fake_user):
        from pkg.api.sources import create_source
        from pkg.schemas.source import SourceCreate
        from pkg.services.foundation.web_extractor import WebPageFetchResult

        fetched = WebPageFetchResult(
            url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
            final_url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
            title="Introducing dynamic workflows in Claude Code",
            text="Dynamic workflows article content",
            metadata={"web_fetch_status": "fetched", "web_fetch_extractor": "trafilatura"},
        )

        async def fake_persist_source(*, body, user_id, **_kwargs):
            source = _make_source("src-web", user_id)
            source.title = body.title
            source.source_type = body.source_type
            source.url = body.url
            source.raw_content = body.raw_content
            source.metadata_ = body.metadata
            return source

        with (
            patch("pkg.api.sources.fetch_web_page", new=AsyncMock(return_value=fetched)) as fetch_mock,
            patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
            patch("pkg.api.sources.maybe_enable_rss_for_source", new=AsyncMock(return_value=False)),
        ):
            source = await create_source(
                SourceCreate(
                    title="Claude blog",
                    category_id=1,
                    source_type="web",
                    url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
                ),
                user=fake_user,
                session=mock_session,
            )

        fetch_mock.assert_awaited_once()
        assert source.raw_content == "Dynamic workflows article content"
        assert source.metadata_["web_fetch_status"] == "fetched"

    @pytest.mark.asyncio
    async def test_web_url_title_is_replaced_with_page_title(self, mock_session, fake_user):
        from pkg.api.sources import create_source
        from pkg.schemas.source import SourceCreate
        from pkg.services.foundation.web_extractor import WebPageFetchResult

        url = "https://claude.com/blog/introducing-dynamic-workflows-in-claude-code"
        fetched = WebPageFetchResult(
            url=url,
            final_url=url,
            title="Introducing dynamic workflows in Claude Code",
            text="Dynamic workflows article content",
            metadata={"web_fetch_status": "fetched"},
        )

        async def fake_persist_source(*, body, user_id, **_kwargs):
            source = _make_source("src-web", user_id)
            source.title = body.title
            source.source_type = body.source_type
            source.url = body.url
            source.raw_content = body.raw_content
            source.metadata_ = body.metadata
            return source

        with (
            patch("pkg.api.sources.fetch_web_page", new=AsyncMock(return_value=fetched)),
            patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
            patch("pkg.api.sources.maybe_enable_rss_for_source", new=AsyncMock(return_value=False)),
        ):
            source = await create_source(
                SourceCreate(title=url, category_id=1, source_type="web", url=url),
                user=fake_user,
                session=mock_session,
            )

        assert source.title == "Introducing dynamic workflows in Claude Code"

    @pytest.mark.asyncio
    async def test_web_url_fetch_failure_returns_422(self, mock_session, fake_user):
        from fastapi import HTTPException
        from pkg.api.sources import create_source
        from pkg.schemas.source import SourceCreate
        from pkg.services.foundation.web_extractor import WebPageFetchError

        with patch(
            "pkg.api.sources.fetch_web_page",
            new=AsyncMock(side_effect=WebPageFetchError("Could not extract readable text from the web page")),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await create_source(
                    SourceCreate(
                        title="Claude blog",
                        category_id=1,
                        source_type="web",
                        url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
                    ),
                    user=fake_user,
                    session=mock_session,
                )

        assert exc_info.value.status_code == 422
        assert "Could not extract readable text" in exc_info.value.detail


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

    @pytest.mark.asyncio
    async def test_delete_legacy_path_id(self, mock_session, fake_user):
        from pkg.api.sources import delete_source_by_id
        from pkg.models.source import Source

        legacy_id = "src-20260603-https://claude.com/blog/introd-5e073745"
        source = _make_source(legacy_id, fake_user.id)
        mock_session.get.side_effect = [source, None]
        mock_chunks = MagicMock()
        mock_chunks.scalars.return_value = []
        mock_session.execute.return_value = mock_chunks

        await delete_source_by_id(legacy_id, user=fake_user, session=mock_session)

        assert mock_session.get.await_args_list[0].args == (Source, legacy_id)
        mock_session.delete.assert_awaited_with(source)
        mock_session.commit.assert_awaited_once()


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


@pytest.mark.asyncio
async def test_list_feed_articles_filters_child_ownership(mock_session, fake_user):
    from pkg.api.sources import list_feed_articles

    parent = _make_source("feed-1", fake_user.id)
    parent.source_type = "web"
    mock_session.get.return_value = parent

    count_rows = MagicMock()
    count_rows.scalar.return_value = 1
    child = _make_source("article-1", fake_user.id)
    child.metadata_ = {"feed_source_id": "feed-1"}
    item_rows = MagicMock()
    item_rows.scalars.return_value = [child]
    mock_session.execute.side_effect = [count_rows, item_rows]

    result = await list_feed_articles("feed-1", limit=20, offset=0, user=fake_user, session=mock_session)

    assert result.total == 1
    assert len(result.items) == 1
    assert result.items[0].id == "article-1"
    executed_sql = [str(call.args[0]) for call in mock_session.execute.await_args_list]
    assert all("sources.user_id" in stmt and "sources.is_shared" in stmt for stmt in executed_sql)
