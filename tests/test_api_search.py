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
