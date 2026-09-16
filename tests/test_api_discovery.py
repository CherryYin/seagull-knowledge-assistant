import pytest


def test_discovery_refresh_rejects_source_owned_providers():
    from pydantic import ValidationError

    from pkg.schemas.discovery import DiscoveryGenerateRequest

    with pytest.raises(ValidationError):
        DiscoveryGenerateRequest(providers=["rss"])

    with pytest.raises(ValidationError):
        DiscoveryGenerateRequest(providers=["web"])


@pytest.mark.asyncio
async def test_search_web_results_passes_user_id_to_search_service(fake_user, mock_session, monkeypatch):
    from pkg.api import discovery as discovery_api
    from pkg.schemas.discovery import DiscoveryWebSearchRequest

    captured = {}

    async def fake_search_external_web_results(query, *, max_results=10, user_id=None):
        captured["query"] = query
        captured["max_results"] = max_results
        captured["user_id"] = user_id
        return []

    async def fake_ingest_web_discovery_results(*args, **kwargs):
        return 0, 0, 0

    monkeypatch.setattr(discovery_api, "search_external_web_results", fake_search_external_web_results)
    monkeypatch.setattr(discovery_api, "ingest_web_discovery_results", fake_ingest_web_discovery_results)

    response = await discovery_api.search_web_results(
        DiscoveryWebSearchRequest(query="agent memory", max_results=5),
        user=fake_user,
        session=mock_session,
    )

    assert response.created == 0
    assert response.updated == 0
    assert response.skipped == 0
    assert captured["user_id"] == fake_user.id


@pytest.mark.asyncio
async def test_preview_web_search_results_is_read_only(fake_user, monkeypatch):
    from pkg.api import discovery as discovery_api
    from pkg.schemas.discovery import DiscoveryWebSearchRequest

    captured = {}

    async def fake_search_external_web_results(query, *, max_results=10, user_id=None):
        captured.update(query=query, max_results=max_results, user_id=user_id)
        return [{
            "title": "Primary source",
            "url": "https://example.com/report",
            "summary": "Current evidence",
            "source_name": "tavily",
            "published_at": None,
        }]

    monkeypatch.setattr(discovery_api, "search_external_web_results", fake_search_external_web_results)

    response = await discovery_api.preview_web_search_results(
        DiscoveryWebSearchRequest(query="agent memory", max_results=5),
        user=fake_user,
    )

    assert len(response) == 1
    assert response[0]["url"] == "https://example.com/report"
    assert captured == {"query": "agent memory", "max_results": 5, "user_id": fake_user.id}
