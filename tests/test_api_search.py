from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_search_route_returns_layered_results_and_logs_activity():
    from pkg.api.search import search
    from pkg.schemas.note import SearchRequest, SearchResult

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    layered = [
        SearchResult(id="wiki-1", title="Canonical Topic", type="wiki", layer="stable_wiki", score=0.91),
        SearchResult(id="asset-1", title="Draft Post", type="asset", layer="asset", score=0.72),
    ]

    retriever_instance = MagicMock()
    retriever_instance.search = AsyncMock(return_value=layered)

    with (
        patch("pkg.api.search.RetrieverAgent", return_value=retriever_instance),
        patch("pkg.api.search.log_activity", new=AsyncMock()) as mock_log,
        patch("pkg.api.search.increment_stats", new=AsyncMock()) as mock_stats,
    ):
        result = await search(
            SearchRequest(query="topic", mode="hybrid", top_k=10),
            user=fake_user,
            session=session,
        )

    assert len(result) == 2
    assert result[0].layer == "stable_wiki"
    assert result[1].layer == "asset"
    mock_log.assert_awaited_once()
    mock_stats.assert_not_awaited()


@pytest.mark.asyncio
async def test_search_route_enriches_media_results_with_thumbnail_and_reason():
    from pkg.api.search import search
    from pkg.schemas.note import SearchRequest, SearchResult

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    media = MagicMock()
    media.source_id = "source-1"
    media.thumbnail_path = "minio://bucket/thumb.jpg"
    media.caption = "Architecture diagram for a retrieval gateway"
    media_rows = MagicMock()
    media_rows.scalars.return_value = [media]
    session.execute.return_value = media_rows
    layered = [
        SearchResult(
            id="source-1",
            title="Gateway diagram",
            type="source",
            layer="raw_evidence",
            score=0.91,
            source_type="image",
        )
    ]
    retriever_instance = MagicMock()
    retriever_instance.search = AsyncMock(return_value=layered)
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://storage/thumb.jpg")

    with (
        patch("pkg.api.search.RetrieverAgent", return_value=retriever_instance),
        patch("pkg.api.search.get_storage_service", return_value=storage),
        patch("pkg.api.search.log_activity", new=AsyncMock()),
        patch("pkg.api.search.increment_stats", new=AsyncMock()),
    ):
        result = await search(
            SearchRequest(query="retrieval gateway", mode="hybrid", top_k=10),
            user=fake_user,
            session=session,
        )

    assert result[0].thumbnail_url == "https://storage/thumb.jpg"
    assert result[0].content_preview == media.caption
    assert result[0].match_reason == "Matched text in the generated media caption."
