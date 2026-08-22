from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.connector_cache import ConnectorSearchItem
from pkg.models.connector_trend import ConnectorTrendItem
from pkg.models.discovery import DiscoveryItem
from pkg.models.source import Source
from pkg.models.user import UserMemory
from pkg.services.foundation.discovery import apply_discovery_feedback, generate_discovery_items
from pkg.services.cross_cutting.user_profiler import PROFILE_MEMORY_KEY
from pkg.services.foundation.discovery_profile import DISCOVERY_PREFERENCES_MEMORY_KEY, load_discovery_preferences, load_discovery_profile


class _ScalarResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


def _select_router(*, profile=None, preferences=None, cached=None, sources=None, discovery_items=None):
    async def _execute(stmt, *args, **kwargs):
        sql = str(stmt)
        if 'FROM user_memories' in sql and f"key = :key_1" in sql:
            params = stmt.compile().params
            key = params.get("key_1")
            if key == PROFILE_MEMORY_KEY:
                return _ScalarResult([profile] if profile else [])
            if key == DISCOVERY_PREFERENCES_MEMORY_KEY:
                return _ScalarResult([preferences] if preferences else [])
            return _ScalarResult([])
        if 'FROM connector_search_items' in sql:
            return _ScalarResult(cached or [])
        if 'FROM sources' in sql:
            return _ScalarResult(sources or [])
        if 'FROM discovery_items' in sql:
            if "count(" in sql.lower():
                pending_count = sum(
                    1 for item in (discovery_items or []) if item.status == "recommended"
                )
                return _ScalarResult([pending_count])
            return _ScalarResult(discovery_items or [])
        return _ScalarResult([])

    return _execute


@pytest.mark.asyncio
async def test_generate_discovery_items_applies_recommended_capacity(monkeypatch):
    session = AsyncMock()
    session.commit = AsyncMock()
    first_item = MagicMock(status="recommended")
    upsert = AsyncMock(side_effect=[(first_item, True), (None, False)])
    candidates = [
        {"provider": "web", "item_key": "one"},
        {"provider": "web", "item_key": "two"},
    ]
    monkeypatch.setattr("pkg.services.foundation.discovery.settings.DISCOVERY_MAX_RECOMMENDED_PER_USER", 2)

    with (
        patch("pkg.services.foundation.discovery.load_discovery_profile", AsyncMock(return_value={})),
        patch("pkg.services.foundation.discovery.load_discovery_preferences", AsyncMock(return_value={})),
        patch("pkg.services.foundation.discovery._recommended_discovery_count", AsyncMock(return_value=1)),
        patch("pkg.services.foundation.discovery._load_candidates", AsyncMock(return_value=candidates)),
        patch("pkg.services.foundation.discovery._upsert_discovery_item", upsert),
    ):
        result = await generate_discovery_items(session, user_id="user-1", providers=["web"])

    assert result == (1, 0, 1)
    assert upsert.await_args_list[0].kwargs["allow_recommended_create"] is True
    assert upsert.await_args_list[1].kwargs["allow_recommended_create"] is False
    session.commit.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_generate_discovery_items_scores_profile_match():
    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(
        user_id="user-1",
        key=PROFILE_MEMORY_KEY,
        value={"interests": [{"domain": "AI", "recent_focus": "RAG"}]},
    )
    cached = ConnectorSearchItem(
        user_id="user-1",
        provider="arxiv",
        item_key="2401.00001",
        title="RAG for AI Memory",
        status="cached",
        payload={
            "arxiv_id": "2401.00001",
            "title": "RAG for AI Memory",
            "authors": ["A. Researcher"],
            "abstract": "A paper about RAG systems for AI memory.",
            "categories": ["cs.AI"],
            "entry_url": "https://arxiv.org/abs/2401.00001",
        },
    )
    cached.updated_at = datetime(2026, 5, 25, tzinfo=timezone.utc)
    session.execute.side_effect = _select_router(profile=profile, cached=[cached])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["arxiv"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "arxiv"
    assert item.score > 20
    assert any("Matches profile interests" in reason for reason in item.why)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_discovery_items_from_rss_source():
    session = AsyncMock()
    session.add = MagicMock()
    rss_source = Source(
        id="src-rss-1",
        user_id="user-1",
        category_id=1,
        title="API architecture article",
        source_type="web",
        url="https://example.com/api",
        raw_content="Detailed article about API architecture and caching.",
        metadata={"feed_source_id": "feed-1", "published_at": "2026-05-25"},
    )
    session.execute.side_effect = _select_router(sources=[rss_source])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["rss"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "rss"
    assert item.source_id == "src-rss-1"
    assert "From a followed RSS feed" in item.why
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_discovery_items_from_news_connector_cache():
    session = AsyncMock()
    session.add = MagicMock()
    cached = ConnectorSearchItem(
        user_id="user-1",
        provider="news",
        item_key="https://example.com/news/openai",
        title="OpenAI ships feature",
        status="cached",
        payload={
            "provider": "newsapi",
            "title": "OpenAI ships feature",
            "url": "https://example.com/news/openai",
            "description": "Summary about launch.",
            "source_name": "Example News",
            "published_at": "2026-05-25T10:00:00Z",
        },
    )
    cached.updated_at = datetime(2026, 5, 25, tzinfo=timezone.utc)
    session.execute.side_effect = _select_router(cached=[cached])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["news"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "news"
    assert item.title == "OpenAI ships feature"
    assert item.url == "https://example.com/news/openai"


@pytest.mark.asyncio
async def test_generate_discovery_items_from_imported_news_source():
    session = AsyncMock()
    session.add = MagicMock()
    news_source = Source(
        id="src-news-1",
        user_id="user-1",
        category_id=1,
        title="AI policy update",
        source_type="article",
        url="https://example.com/news/policy",
        raw_content="Article body.",
        metadata={
            "kind": "news",
            "provider": "newsapi",
            "source_name": "Policy Daily",
            "description": "Policy summary.",
            "published_at": "2026-05-24T08:00:00Z",
            "dedupe_key": "newsapi:https://example.com/news/policy",
        },
    )
    session.execute.side_effect = _select_router(sources=[news_source])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["news"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "news"
    assert item.source_id == "src-news-1"
    assert item.payload["source_name"] == "Policy Daily"
    assert item.payload["published_at"] == "2026-05-24T08:00:00Z"
    assert any("Recent news article" in reason for reason in item.why)


@pytest.mark.asyncio
async def test_generate_discovery_items_from_web_source_with_credibility_and_preferences():
    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(user_id="user-1", key=PROFILE_MEMORY_KEY, value={"discovery_feedback": {"web": {"keep": 2, "dismiss": 0}}})
    web_source = Source(
        id="src-web-1",
        user_id="user-1",
        category_id=1,
        title="Knowledge graph architecture guide",
        source_type="web",
        url="https://example.com/kg",
        raw_content="A guide about knowledge graph architecture.",
        metadata={},
    )
    session.execute.side_effect = _select_router(profile=profile, sources=[web_source])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["web"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "web"
    assert any("HTTPS source" in reason for reason in item.why)
    assert any("Boosted by your keep/save history" in reason for reason in item.why)


@pytest.mark.asyncio
async def test_generate_discovery_items_adds_memory_similarity_reason():
    session = AsyncMock()
    session.add = MagicMock()
    cached = ConnectorSearchItem(
        user_id="user-1",
        provider="github",
        item_key="owner/rag-tool",
        title="owner/rag-tool",
        status="cached",
        payload={
            "full_name": "owner/rag-tool",
            "owner": "owner",
            "name": "rag-tool",
            "description": "RAG memory retrieval toolkit",
            "topics": ["rag"],
            "stars": 42,
            "forks": 3,
            "html_url": "https://github.com/owner/rag-tool",
        },
    )
    cached.updated_at = datetime(2026, 5, 25, tzinfo=timezone.utc)
    memory_node = MagicMock()
    memory_node.title = "Memory retrieval architecture"
    session.execute.side_effect = _select_router(cached=[cached])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = [MagicMock(node=memory_node)]
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["github"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert any("Similar to memory" in reason for reason in item.why)


@pytest.mark.asyncio
async def test_generate_discovery_items_uses_trend_metadata_payload():
    session = AsyncMock()
    session.add = MagicMock()
    trend = ConnectorTrendItem(
        user_id="user-1",
        provider="github",
        trend_date="2026-06-12",
        item_key="owner/trending-repo",
        title="owner/trending-repo",
        metadata_={
            "full_name": "owner/trending-repo",
            "owner": "owner",
            "name": "trending-repo",
            "description": "A trending repository about memory systems.",
            "topics": ["memory"],
            "stars": 120,
            "forks": 8,
            "html_url": "https://github.com/owner/trending-repo",
        },
    )

    async def execute(stmt, *args, **kwargs):
        sql = str(stmt)
        if "FROM connector_search_items" in sql:
            return _ScalarResult([])
        if "FROM connector_trend_items" in sql:
            return _ScalarResult([trend])
        if "FROM discovery_items" in sql:
            return _ScalarResult([])
        if "FROM user_memories" in sql:
            return _ScalarResult([])
        if "FROM sources" in sql:
            return _ScalarResult([])
        return _ScalarResult([])

    session.execute.side_effect = execute

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["github"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "github"
    assert item.payload["full_name"] == "owner/trending-repo"


@pytest.mark.asyncio
async def test_dismiss_discovery_item_updates_profile_feedback():
    session = AsyncMock()
    session.add = MagicMock()
    item = DiscoveryItem(
        user_id="user-1",
        provider="github",
        item_key="owner/repo",
        title="owner/repo",
        payload={"full_name": "owner/repo", "html_url": "https://github.com/owner/repo", "owner": "owner", "name": "repo", "topics": [], "stars": 1, "forks": 0},
    )
    preference_memory = UserMemory(user_id="user-1", key=DISCOVERY_PREFERENCES_MEMORY_KEY, value={})
    session.execute.side_effect = _select_router(preferences=preference_memory)

    source, created = await apply_discovery_feedback(session, item=item, action="dismiss")

    assert source is None
    assert created is None
    assert item.status == "dismissed"
    assert preference_memory.value["discovery_feedback"]["github"]["dismiss"] == 1
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_keep_existing_source_does_not_reimport():
    session = AsyncMock()
    session.add = MagicMock()
    source = MagicMock(spec=Source)
    source.id = "src-1"
    session.get.return_value = source
    session.execute.return_value = _ScalarResult([])
    item = DiscoveryItem(
        user_id="user-1",
        provider="github",
        item_key="owner/repo",
        title="owner/repo",
        payload={"full_name": "owner/repo", "html_url": "https://github.com/owner/repo", "owner": "owner", "name": "repo", "topics": [], "stars": 1, "forks": 0},
        source_id="src-1",
    )

    with patch("pkg.services.foundation.discovery.import_github_repo") as mock_import:
        result_source, created = await apply_discovery_feedback(session, item=item, action="keep")

    assert result_source == source
    assert created is False
    assert item.status == "kept"
    mock_import.assert_not_called()


@pytest.mark.asyncio
async def test_keep_without_existing_source_does_not_import():
    session = AsyncMock()
    session.add = MagicMock()
    session.execute.return_value = _ScalarResult([])
    item = DiscoveryItem(
        user_id="user-1",
        provider="github",
        item_key="owner/repo",
        title="owner/repo",
        payload={"full_name": "owner/repo", "html_url": "https://github.com/owner/repo", "owner": "owner", "name": "repo", "topics": [], "stars": 1, "forks": 0},
    )

    with patch("pkg.services.foundation.discovery.import_github_repo") as mock_import:
        result_source, created = await apply_discovery_feedback(session, item=item, action="keep")

    assert result_source is None
    assert created is None
    assert item.status == "kept"
    assert item.source_id is None
    mock_import.assert_not_called()


@pytest.mark.asyncio
async def test_save_openalex_discovery_item_imports_article_source():
    session = AsyncMock()
    session.add = MagicMock()
    session.get.return_value = None
    session.execute.return_value = _ScalarResult([])
    item = DiscoveryItem(
        id=7,
        user_id="user-1",
        provider="openalex",
        item_key="openalex:W123",
        title="Agent Memory Systems",
        url="https://openalex.org/W123",
        summary="A paper about agent memory.",
        payload={
            "paper_provider_id": "https://openalex.org/W123",
            "authors": ["Alice"],
            "abstract": "A paper about agent memory.",
            "fields_of_study": ["Computer Science"],
            "venue": "Conference",
            "year": 2026,
            "citation_count": 12,
            "doi": "10.1234/example",
            "url": "https://openalex.org/W123",
        },
    )

    with patch("pkg.services.foundation.discovery.maybe_upsert_source_memory_node", new_callable=AsyncMock) as mock_upsert:
        source, created = await apply_discovery_feedback(session, item=item, action="save")

    assert created is True
    assert source.id.startswith("src-paper-")
    assert source.source_type == "article"
    assert source.metadata_["connector"] == "openalex"
    assert source.metadata_["doi"] == "10.1234/example"
    assert "## Abstract" in source.raw_content
    assert item.status == "saved"
    assert item.source_id == source.id
    assert session.add.call_args_list[0].args[0] == source
    mock_upsert.assert_awaited_once_with(session, source)


@pytest.mark.asyncio
async def test_web_discovery_ingest_scores_trusted_domain():
    from pkg.services.foundation.discovery import ingest_web_discovery_results

    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(user_id="user-1", key=PROFILE_MEMORY_KEY, value={})
    session.execute.side_effect = _select_router(profile=profile)

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await ingest_web_discovery_results(
            session,
            user_id="user-1",
            query="knowledge graph",
            items=[{"title": "OpenAI docs", "url": "https://openai.com/research", "summary": "Research update"}],
        )

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert item.provider == "web"
    assert item.payload["discovery_source"] == "external_web_search"
    assert any("Trusted domain" in reason for reason in item.why)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_feedback_updates_fine_grained_preferences():
    session = AsyncMock()
    session.add = MagicMock()
    item = DiscoveryItem(
        user_id="user-1",
        provider="web",
        item_key="web:1",
        title="OpenAI research",
        url="https://openai.com/research",
        payload={"url": "https://openai.com/research", "domain": "openai.com", "source_name": "search", "query": "ai research"},
    )
    preference_memory = UserMemory(user_id="user-1", key=DISCOVERY_PREFERENCES_MEMORY_KEY, value={})
    session.execute.side_effect = _select_router(preferences=preference_memory)

    source, created = await apply_discovery_feedback(session, item=item, action="dismiss")

    assert source is None
    assert created is None
    assert preference_memory.value["discovery_feedback"]["web"]["dismiss"] == 1
    assert preference_memory.value["discovery_preferences"]["domains"]["openai.com"]["dismiss"] == 1
    assert preference_memory.value["discovery_preferences"]["sources"]["search"]["dismiss"] == 1


@pytest.mark.asyncio
async def test_load_discovery_profile_returns_profile_memory_only():
    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(user_id="user-1", key=PROFILE_MEMORY_KEY, value={"summary": "AI builder"})
    session.execute.side_effect = _select_router(profile=profile)

    result = await load_discovery_profile(session, "user-1")

    assert result["summary"] == "AI builder"


@pytest.mark.asyncio
async def test_load_discovery_preferences_reads_preference_memory():
    session = AsyncMock()
    session.add = MagicMock()
    preferences = UserMemory(
        user_id="user-1",
        key=DISCOVERY_PREFERENCES_MEMORY_KEY,
        value={"discovery_preferences": {"domains": {"openai.com": {"keep": 2}}}},
    )
    session.execute.side_effect = _select_router(preferences=preferences)

    result = await load_discovery_preferences(session, "user-1")

    assert result["discovery_preferences"]["domains"]["openai.com"]["keep"] == 2


@pytest.mark.asyncio
async def test_generate_discovery_items_uses_domain_preferences():
    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(
        user_id="user-1",
        key=PROFILE_MEMORY_KEY,
        value={"discovery_preferences": {"domains": {"openai.com": {"keep": 2}}}},
    )
    web_source = Source(
        id="src-web-openai",
        user_id="user-1",
        category_id=1,
        title="OpenAI guide",
        source_type="web",
        url="https://openai.com/guide",
        raw_content="Guide about AI agents.",
        metadata={},
    )
    session.execute.side_effect = _select_router(profile=profile, sources=[web_source])

    with patch("pkg.services.foundation.discovery.retrieve_for_query", new_callable=AsyncMock) as mock_memory:
        mock_memory.return_value = []
        created, updated, skipped = await generate_discovery_items(session, user_id="user-1", providers=["web"])

    assert (created, updated, skipped) == (1, 0, 0)
    item = session.add.call_args.args[0]
    assert any("Trusted domain" in reason for reason in item.why)
    assert any("domain preference" in reason.lower() or "kept domain" in reason.lower() for reason in item.why)


@pytest.mark.asyncio
async def test_search_external_web_results_maps_tavily_response(monkeypatch):
    from pkg.config import settings
    from pkg.services.foundation.discovery import search_external_web_results

    class FakeTavilyClient:
        def __init__(self, api_key):
            assert api_key == "test-key"

        def search(self, **kwargs):
            assert kwargs["query"] == "agent memory"
            assert kwargs["max_results"] == 3
            return {
                "results": [
                    {
                        "title": "Agent memory guide",
                        "url": "https://openai.com/agent-memory",
                        "content": "A guide about agent memory.",
                        "published_date": "2026-05-26",
                    }
                ]
            }

    monkeypatch.setattr(settings, "TAVILY_API_KEY", "test-key")
    import types
    import sys

    fake_module = types.SimpleNamespace(TavilyClient=FakeTavilyClient)
    monkeypatch.setitem(sys.modules, "tavily", fake_module)

    items = await search_external_web_results("agent memory", max_results=3)

    assert items == [
        {
            "title": "Agent memory guide",
            "url": "https://openai.com/agent-memory",
            "summary": "A guide about agent memory.",
            "source_name": "tavily",
            "published_at": "2026-05-26",
        }
    ]


@pytest.mark.asyncio
async def test_search_external_web_results_prefers_user_db_tavily_key(monkeypatch):
    from pkg.config import settings
    from pkg.services.foundation.discovery import search_external_web_results

    class FakeTavilyClient:
        def __init__(self, api_key):
            assert api_key == "db-key"

        def search(self, **kwargs):
            return {"results": []}

    monkeypatch.setattr(settings, "TAVILY_API_KEY", "env-key")
    import types
    import sys

    fake_module = types.SimpleNamespace(TavilyClient=FakeTavilyClient)
    monkeypatch.setitem(sys.modules, "tavily", fake_module)

    async def fake_get_default_user_api_credential_secret(session, *, user_id, provider):
        assert user_id == "user-1"
        assert provider == "tavily"
        return "db-key", {}

    monkeypatch.setattr(
        "pkg.services.foundation.discovery.get_default_user_api_credential_secret",
        fake_get_default_user_api_credential_secret,
    )

    items = await search_external_web_results("agent memory", max_results=3, user_id="user-1")

    assert items == []


@pytest.mark.asyncio
async def test_ingest_web_discovery_results_rejects_non_http_url():
    from pkg.services.foundation.discovery import ingest_web_discovery_results

    session = AsyncMock()
    session.add = MagicMock()
    session.execute.side_effect = _select_router()

    created, updated, skipped = await ingest_web_discovery_results(
        session,
        user_id="user-1",
        query="bad url",
        items=[{"title": "Bad", "url": "javascript:alert(1)", "summary": "bad"}],
    )

    assert (created, updated, skipped) == (0, 0, 1)
    session.add.assert_not_called()


@pytest.mark.asyncio
async def test_import_web_discovery_item_rejects_non_http_url():
    from pkg.services.foundation.discovery import apply_discovery_feedback

    session = AsyncMock()
    session.add = MagicMock()
    session.execute.return_value = _ScalarResult([])
    item = DiscoveryItem(
        user_id="user-1",
        provider="web",
        item_key="web:bad",
        title="Bad",
        url="javascript:alert(1)",
        payload={"url": "javascript:alert(1)"},
    )

    with pytest.raises(ValueError):
        await apply_discovery_feedback(session, item=item, action="save")
