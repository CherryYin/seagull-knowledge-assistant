"""Tests for sources API endpoints (/sources/*)."""

import hashlib
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_upload_pdf_records_extraction_metadata_without_review(mock_session, fake_user):
    from pkg.api.sources import upload_source

    category = MagicMock()
    category.name = "General"
    mock_session.get.return_value = category
    uploaded = _make_source("src-upload", fake_user.id)
    captured = {}

    async def fake_persist_source(*, body, **_kwargs):
        captured["body"] = body
        uploaded.metadata_ = body.metadata
        return uploaded

    storage = MagicMock()
    storage.build_object_key.return_value = "sources/upload.pdf"
    storage.upload_bytes = AsyncMock(return_value="minio://sources/upload.pdf")
    file = MagicMock()
    file.filename = "upload.pdf"
    file.content_type = "application/pdf"
    file.read = AsyncMock(return_value=b"%PDF-1.7 mock")

    with (
        patch("pkg.api.sources.extract_text_content", new=AsyncMock(return_value="Extracted PDF text")),
        patch("pkg.api.sources.find_owned_uploaded_source_by_hash", new=AsyncMock(return_value=None)),
        patch("pkg.api.sources.get_storage_service", return_value=storage),
        patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
    ):
        result = await upload_source(
            response=MagicMock(),
            file=file,
            title="Uploaded PDF",
            source_type="pdf",
            category_id=1,
            url=None,
            pdf_type="text",
            user=fake_user,
            session=mock_session,
        )

    assert result.id == "src-upload"
    assert result.created is True
    assert result.duplicate is False
    assert captured["body"].metadata["extraction_status"] == "completed"
    assert captured["body"].metadata["extraction_mode"] == "pymupdf"
    assert "review_status" not in captured["body"].metadata


@pytest.mark.asyncio
async def test_upload_duplicate_returns_existing_source_without_extracting_or_storing(mock_session, fake_user):
    from pkg.api.sources import upload_source

    existing = _make_source("src-existing", fake_user.id)
    existing.file_path = "minio://sources/existing.pdf"
    payload = b"identical file bytes"
    content_hash = hashlib.sha256(payload).hexdigest()
    existing.content_hash = content_hash
    file = MagicMock()
    file.filename = "same-again.pdf"
    file.content_type = "application/pdf"
    file.read = AsyncMock(return_value=payload)
    response = MagicMock()
    find_duplicate = AsyncMock(return_value=existing)

    with (
        patch("pkg.api.sources.find_owned_uploaded_source_by_hash", new=find_duplicate),
        patch("pkg.api.sources.extract_text_content", new=AsyncMock()) as extract_text,
        patch("pkg.api.sources.get_storage_service") as get_storage,
        patch("pkg.api.sources.persist_source", new=AsyncMock()) as persist,
    ):
        result = await upload_source(
            response=response,
            file=file,
            title="Same Again",
            source_type="pdf",
            category_id=1,
            url=None,
            pdf_type="text",
            user=fake_user,
            session=mock_session,
        )

    assert response.status_code == 200
    assert result.id == "src-existing"
    assert result.created is False
    assert result.duplicate is True
    find_duplicate.assert_awaited_once_with(mock_session, user_id=fake_user.id, content_hash=content_hash)
    extract_text.assert_not_awaited()
    get_storage.assert_not_called()
    persist.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source_type", "filename", "content_type"),
    [
        ("image", "diagram.png", "image/png"),
        ("video", "demo.mp4", "video/mp4"),
    ],
)
async def test_upload_media_stores_original_without_document_extraction(
    mock_session,
    fake_user,
    source_type,
    filename,
    content_type,
):
    from pkg.api.sources import upload_source

    category = MagicMock()
    category.name = "General"
    mock_session.get.return_value = category
    uploaded = _make_source("src-media", fake_user.id)
    uploaded.source_type = source_type
    uploaded.description = "A searchable description"
    captured = {}

    async def fake_persist_source(*, body, **_kwargs):
        captured["body"] = body
        uploaded.metadata_ = body.metadata
        return uploaded

    storage = MagicMock()
    storage.build_object_key.return_value = f"sources/{filename}"
    storage.upload_bytes = AsyncMock(return_value=f"minio://sources/{filename}")
    file = MagicMock()
    file.filename = filename
    file.content_type = content_type
    file.read = AsyncMock(return_value=b"media bytes")

    with (
        patch("pkg.api.sources.extract_text_content", new=AsyncMock()) as extract_text,
        patch("pkg.api.sources.find_owned_uploaded_source_by_hash", new=AsyncMock(return_value=None)),
        patch("pkg.api.sources.get_storage_service", return_value=storage),
        patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
        patch("pkg.api.sources.queue_media_processing", new=AsyncMock()) as queue_processing,
    ):
        result = await upload_source(
            response=MagicMock(),
            file=file,
            title="Saved media",
            source_type=source_type,
            category_id=1,
            url=None,
            description="A searchable description",
            pdf_type=None,
            user=fake_user,
            session=mock_session,
        )

    extract_text.assert_not_awaited()
    assert result.created is True
    assert captured["body"].description == "A searchable description"
    assert captured["body"].raw_content is None
    assert captured["body"].metadata["extraction_status"] == "not_applicable"
    assert captured["body"].metadata["description_status"] == "completed"
    assert captured["body"].metadata["original_filename"] == filename
    queue_processing.assert_awaited_once_with(mock_session, uploaded)


@pytest.mark.asyncio
async def test_upload_rejects_file_that_does_not_match_media_type(mock_session, fake_user):
    from fastapi import HTTPException

    from pkg.api.sources import upload_source

    file = MagicMock()
    file.filename = "notes.txt"
    file.content_type = "text/plain"
    file.read = AsyncMock(return_value=b"not an image")

    with pytest.raises(HTTPException) as exc_info:
        await upload_source(
            response=MagicMock(),
            file=file,
            title="Wrong file",
            source_type="image",
            category_id=1,
            url=None,
            description=None,
            pdf_type=None,
            user=fake_user,
            session=mock_session,
        )

    assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_persist_source_records_index_status(mock_session, fake_user):
    from pkg.api.sources import persist_source
    from pkg.schemas.source import SourceCreate

    with patch("pkg.api.sources.upsert_source_embeddings", new=AsyncMock(return_value=True)):
        source = await persist_source(
            session=mock_session,
            body=SourceCreate(
                title="Manual PDF",
                source_type="pdf",
                raw_content="Readable content",
                metadata={"extraction_status": "completed"},
            ),
            user_id=fake_user.id,
        )

    assert source.metadata_["extraction_status"] == "completed"
    assert source.metadata_["index_status"] == "completed"
    assert source.metadata_["indexed_at"]
    assert "review_status" not in source.metadata_


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


@pytest.mark.asyncio
async def test_get_source_chunk_count_supports_owned_source(mock_session, fake_user):
    from pkg.api.sources import get_source_chunk_count

    source = _make_source("src-1", fake_user.id)
    count_result = MagicMock()
    count_result.scalar.return_value = 4
    mock_session.get.return_value = source
    mock_session.execute.return_value = count_result

    result = await get_source_chunk_count("src-1", user=fake_user, session=mock_session)

    assert result == {"count": 4}

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

    @pytest.mark.asyncio
    async def test_list_sources_supports_kind_filter(self, mock_session, fake_user):
        from pkg.api.sources import list_sources

        news_source = _make_source("src-news-1", fake_user.id)
        news_source.source_type = "article"
        news_source.metadata_ = {"kind": "news", "source_name": "Example News"}
        news_source.ingested_at = datetime.now(timezone.utc)

        mock_count = MagicMock()
        mock_count.scalar.return_value = 1
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = [news_source]
        mock_cat_rows = MagicMock()
        category = MagicMock()
        category.id = 1
        category.name = "general"
        mock_cat_rows.scalars.return_value = [category]
        mock_session.execute.side_effect = [mock_count, mock_rows, mock_cat_rows]

        result = await list_sources(
            kind="news",
            offset=0,
            limit=50,
            user=fake_user,
            session=mock_session,
        )

        assert result.total == 1
        assert len(result.items) == 1
        assert result.items[0].metadata_["kind"] == "news"
        executed_sql = str(mock_session.execute.await_args_list[0].args[0])
        assert "metadata->>'kind' = :kind" in executed_sql

    @pytest.mark.asyncio
    async def test_list_sources_supports_review_status_filter(self, mock_session, fake_user):
        from pkg.api.sources import list_sources

        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [mock_count, mock_rows]

        result = await list_sources(
            review_status="imported_reviewable",
            feed_view="all",
            offset=0,
            limit=100,
            user=fake_user,
            session=mock_session,
        )

        assert result.total == 0
        executed_sql = str(mock_session.execute.await_args_list[0].args[0])
        assert "metadata->>'review_status' = :review_status" in executed_sql


# ---------------------------------------------------------------------------
# PATCH /sources/{source_id}
# ---------------------------------------------------------------------------
class TestUpdateSource:
    @pytest.mark.asyncio
    async def test_update_source_can_replace_metadata(self, mock_session, fake_user):
        from pkg.api.sources import update_source
        from pkg.schemas.source import SourceUpdate

        source = _make_source("src-1", fake_user.id)
        source.source_type = "web"
        source.metadata_ = {"auto_refresh": False}
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        result = await update_source(
            "src-1",
            SourceUpdate(metadata={"auto_refresh": True, "refresh_interval_days": 7}),
            user=fake_user,
            session=mock_session,
        )

        assert result.id == "src-1"
        assert source.metadata_ == {"auto_refresh": True, "refresh_interval_days": 7}
        mock_session.commit.assert_awaited()
        mock_session.refresh.assert_awaited_with(source)

    @pytest.mark.asyncio
    async def test_update_article_source_cannot_remove_permanent_retention(self, mock_session, fake_user):
        from pkg.api.sources import update_source
        from pkg.schemas.source import SourceUpdate

        source = _make_source("src-article", fake_user.id)
        source.source_type = "article"
        source.metadata_ = {"retention": "permanent"}
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        result = await update_source(
            "src-article",
            SourceUpdate(metadata={"retention": "temporary", "tags": ["updated"]}),
            user=fake_user,
            session=mock_session,
        )

        assert result.metadata_["retention"] == "permanent"
        assert result.metadata_["tags"] == ["updated"]

    @pytest.mark.asyncio
    async def test_update_source_empty_patch_returns_existing_source(self, mock_session, fake_user):
        from pkg.api.sources import update_source
        from pkg.schemas.source import SourceUpdate

        source = _make_source("src-1", fake_user.id)
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        result = await update_source("src-1", SourceUpdate(), user=fake_user, session=mock_session)

        assert result.id == "src-1"
        mock_session.commit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_update_media_description_rebuilds_search_index(self, mock_session, fake_user):
        from pkg.api.sources import update_source
        from pkg.schemas.source import SourceUpdate

        source = _make_source("src-image", fake_user.id)
        source.source_type = "image"
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        with patch("pkg.api.sources.upsert_source_embeddings", new=AsyncMock(return_value=True)) as reindex:
            result = await update_source(
                "src-image",
                SourceUpdate(description="Architecture diagram for the retrieval pipeline"),
                user=fake_user,
                session=mock_session,
            )

        assert result.description == "Architecture diagram for the retrieval pipeline"
        assert source.metadata_["description_status"] == "completed"
        assert source.metadata_["index_status"] == "completed"
        reindex.assert_awaited_once_with(mock_session, source)

    @pytest.mark.asyncio
    async def test_update_media_extraction_content_rebuilds_search_index(self, mock_session, fake_user):
        from pkg.api.sources import update_source
        from pkg.schemas.source import SourceUpdate

        source = _make_source("src-image", fake_user.id)
        source.source_type = "image"
        source.raw_content = None
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        with patch("pkg.api.sources.upsert_source_embeddings", new=AsyncMock(return_value=True)) as reindex:
            result = await update_source(
                "src-image",
                SourceUpdate(raw_content="  Diagram label: retrieval gateway\x00  "),
                user=fake_user,
                session=mock_session,
            )

        assert result.raw_content == "Diagram label: retrieval gateway"
        assert source.metadata_["extraction_status"] == "completed"
        assert source.metadata_["extraction_mode"] == "manual_edit"
        assert source.metadata_["index_status"] == "completed"
        reindex.assert_awaited_once_with(mock_session, source)


@pytest.mark.asyncio
async def test_generate_media_description_returns_unsaved_proposal(mock_session, fake_user):
    from pkg.api.sources import generate_source_description

    source = _make_source(
        "src-image",
        fake_user.id,
        file_path="minio://sources/image.png",
    )
    source.source_type = "image"
    source.metadata_ = {"original_filename": "image.png"}
    mock_session.get.return_value = source
    storage = MagicMock()
    storage.get_object = AsyncMock(return_value=b"image bytes")

    with (
        patch("pkg.api.sources.get_storage_service", return_value=storage),
        patch(
            "pkg.api.sources.generate_media_description",
            new=AsyncMock(return_value=("A generated image description", "vision-model")),
        ),
    ):
        proposal = await generate_source_description(
            "src-image",
            user=fake_user,
            session=mock_session,
        )

    assert proposal.description == "A generated image description"
    assert proposal.model == "vision-model"
    assert source.description is None
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_media_file_url_returns_owned_presigned_url(mock_session, fake_user):
    from pkg.api.sources import get_source_file_url

    source = _make_source(
        "src-video",
        fake_user.id,
        file_path="minio://sources/video.mp4",
    )
    source.source_type = "video"
    mock_session.get.return_value = source
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://storage.example/video.mp4")

    with patch("pkg.api.sources.get_storage_service", return_value=storage):
        access = await get_source_file_url("src-video", user=fake_user, session=mock_session)

    assert access.url == "https://storage.example/video.mp4"
    assert access.expires_in_seconds


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
    async def test_media_source_requires_original_upload(self, mock_session, fake_user):
        from fastapi import HTTPException

        from pkg.api.sources import create_source
        from pkg.schemas.source import SourceCreate

        with pytest.raises(HTTPException) as exc_info:
            await create_source(
                SourceCreate(title="Loose image", source_type="image", description="No file"),
                user=fake_user,
                session=mock_session,
            )

        assert exc_info.value.status_code == 422

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
        assert source.metadata_["web_role"] == "page"
        assert source.metadata_["origin"] == "manual_url"
        assert source.metadata_["review_status"] == "reviewed_kept"

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
    async def test_web_rss_mode_validates_feed_and_preserves_page_url(self, mock_session, fake_user):
        from pkg.api.sources import create_source
        from pkg.schemas.source import SourceCreate

        captured = {}

        async def fake_persist_source(*, body, user_id, **_kwargs):
            captured["body"] = body
            source = _make_source("src-feed", user_id)
            source.title = body.title
            source.source_type = body.source_type
            source.url = body.url
            source.raw_content = body.raw_content
            source.metadata_ = body.metadata
            return source

        discovered = {
            "feed_title": "Example Feed",
            "feed_url": "https://example.com/feed.xml",
            "entries_available": 12,
        }
        with (
            patch("pkg.api.sources.discover_rss_feed", new=AsyncMock(return_value=discovered)),
            patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
            patch("pkg.services.foundation.rss_fetcher.fetch_single_feed", new=AsyncMock(return_value=0)) as fetch_feed,
            patch("pkg.api.sources.fetch_web_page", new=AsyncMock()) as fetch_page,
        ):
            source = await create_source(
                SourceCreate(
                    title="Example Blog",
                    category_id=1,
                    source_type="web",
                    url="https://example.com/blog",
                    metadata={"web_role": "collection_feed"},
                ),
                user=fake_user,
                session=mock_session,
            )

        assert source.url == "https://example.com/blog"
        assert captured["body"].metadata["web_role"] == "collection_feed"
        assert captured["body"].metadata["feed_url"] == "https://example.com/feed.xml"
        assert captured["body"].metadata["review_status"] == "reviewed_kept"
        fetch_page.assert_not_awaited()
        fetch_feed.assert_awaited_once_with(source, mock_session)

    @pytest.mark.asyncio
    async def test_web_directory_mode_stays_directory_after_page_extraction(self, mock_session, fake_user):
        from pkg.api.sources import create_source
        from pkg.schemas.source import SourceCreate
        from pkg.services.foundation.web_extractor import WebPageFetchResult

        fetched = WebPageFetchResult(
            url="https://example.com/blog",
            final_url="https://example.com/blog",
            title="Example Blog",
            text="Blog index",
            metadata={"web_fetch_status": "fetched"},
        )

        async def fake_persist_source(*, body, user_id, **_kwargs):
            source = _make_source("src-directory", user_id)
            source.title = body.title
            source.source_type = body.source_type
            source.url = body.url
            source.raw_content = body.raw_content
            source.metadata_ = body.metadata
            return source

        with (
            patch("pkg.api.sources.fetch_web_page", new=AsyncMock(return_value=fetched)),
            patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
            patch("pkg.api.sources.discover_rss_feed", new=AsyncMock()) as discover_feed,
        ):
            source = await create_source(
                SourceCreate(
                    title="Example Blog",
                    category_id=1,
                    source_type="web",
                    url="https://example.com/blog",
                    metadata={"web_role": "collection_directory"},
                ),
                user=fake_user,
                session=mock_session,
            )

        assert source.metadata_["web_role"] == "collection_directory"
        assert source.metadata_["review_status"] == "reviewed_kept"
        discover_feed.assert_not_awaited()

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
        # get calls: source, media, embedding
        mock_session.get.side_effect = [source, None, None]
        # execute for chunks query
        mock_chunks = MagicMock()
        mock_chunks.scalars.return_value = []
        mock_session.execute.return_value = mock_chunks

        sync_review = AsyncMock()
        with patch("pkg.api.sources.sync_discovery_review_for_source", sync_review):
            resp = client.delete("/sources/src-1")

        assert resp.status_code == 204
        sync_review.assert_awaited_once_with(mock_session, source=source, status="dismissed")
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
        mock_session.get.side_effect = [source, None, None]
        mock_chunks = MagicMock()
        mock_chunks.scalars.return_value = []
        mock_session.execute.return_value = mock_chunks

        sync_review = AsyncMock()
        with patch("pkg.api.sources.sync_discovery_review_for_source", sync_review):
            await delete_source_by_id(legacy_id, user=fake_user, session=mock_session)

        assert mock_session.get.await_args_list[0].args == (Source, legacy_id)
        sync_review.assert_awaited_once_with(mock_session, source=source, status="dismissed")
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
    source.description = None
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

    with patch(
        "pkg.api.sources.sync_discovery_review_for_source",
        new_callable=AsyncMock,
    ) as mock_sync_discovery:
        result = await keep_imported_source("src-imported", user=fake_user, session=mock_session)

    assert result.id == "src-imported"
    assert result.category_name == "General"
    assert source.metadata_["review_status"] == "reviewed_kept"
    assert source.metadata_["retention"] == "permanent"
    assert source.metadata_["reviewed_at"]
    assert source.metadata_["kept_at"]
    mock_sync_discovery.assert_awaited_once_with(mock_session, source=source, status="saved")
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
