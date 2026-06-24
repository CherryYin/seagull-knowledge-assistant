from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.schemas.connector import ArxivPaper, GitHubRepo, NewsArticle
from pkg.services.foundation.connectors import (
    ArxivRateLimitError,
    NewsRateLimitError,
    _canonicalize_news_url,
    arxiv_source_id,
    build_arxiv_query,
    build_github_query,
    github_source_id,
    import_arxiv_paper,
    import_github_repo,
    import_news_article,
    one_year_ago_date,
    parse_arxiv_feed,
    search_news_articles,
    search_arxiv,
    search_github_repos,
)


def test_build_arxiv_query_supports_filters():
    query = build_arxiv_query(query="agentic rag", author="Smith", category="cs.AI", date_from="2024-01-01", date_to="2024-12-31")
    assert "all:agentic rag" in query
    assert "au:Smith" in query
    assert "cat:cs.AI" in query
    assert "submittedDate" in query


def test_parse_arxiv_feed_extracts_metadata():
    payload = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/2401.12345v1</id>
        <updated>2024-01-03T00:00:00Z</updated>
        <published>2024-01-02T00:00:00Z</published>
        <title> Test Paper </title>
        <summary> Abstract text. </summary>
        <author><name>Alice</name></author>
        <category term="cs.AI" />
        <arxiv:doi>10.123/test</arxiv:doi>
        <link title="pdf" href="https://arxiv.org/pdf/2401.12345v1" type="application/pdf" />
      </entry>
    </feed>"""
    papers = parse_arxiv_feed(payload)
    assert len(papers) == 1
    assert papers[0].arxiv_id == "2401.12345v1"
    assert papers[0].title == "Test Paper"
    assert papers[0].authors == ["Alice"]
    assert papers[0].categories == ["cs.AI"]
    assert papers[0].doi == "10.123/test"


def test_connector_source_ids_are_deterministic():
    assert arxiv_source_id("https://arxiv.org/abs/2401.12345v1") == "src-arxiv-2401.12345v1"
    assert github_source_id("OpenAI/Codex") == "src-github-openai-codex"


def test_build_github_query_supports_qualifiers():
    query = build_github_query(query="agent framework", language="Python", topic="agents", min_stars=100, pushed_after="2024-01-01")
    assert query == "agent framework language:Python topic:agents stars:>=100 pushed:>=2024-01-01"


def test_one_year_ago_date_uses_365_day_window():
    assert one_year_ago_date(datetime(2026, 5, 28, tzinfo=timezone.utc)) == "2025-05-28"


@pytest.mark.asyncio
async def test_search_arxiv_defaults_to_past_year(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        text = "<feed xmlns=\"http://www.w3.org/2005/Atom\" />"

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            captured["params"] = params
            return Response()

    monkeypatch.setattr("pkg.services.foundation.connectors.one_year_ago_date", lambda: "2025-05-28")
    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)

    await search_arxiv(query="agentic rag")

    assert "submittedDate:[202505280000+TO+299912312359]" in captured["params"]["search_query"]



@pytest.mark.asyncio
async def test_search_arxiv_raises_rate_limit_after_retries(monkeypatch):
    calls = 0

    class Response:
        status_code = 429
        text = ""
        headers = {"Retry-After": "30"}

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            nonlocal calls
            calls += 1
            return Response()

    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)

    with pytest.raises(ArxivRateLimitError, match="arXiv rate limit exceeded"):
        await search_arxiv(query="agentic rag", retries=0)

    assert calls == 1


@pytest.mark.asyncio
async def test_search_arxiv_retries_429_with_retry_after(monkeypatch):
    calls = 0
    sleeps: list[float] = []

    class Response:
        def __init__(self, status_code, text=""):
            self.status_code = status_code
            self.text = text
            self.headers = {"Retry-After": "7"} if status_code == 429 else {}

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            nonlocal calls
            calls += 1
            if calls == 1:
                return Response(429)
            return Response(200, '<feed xmlns="http://www.w3.org/2005/Atom" />')

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)
    monkeypatch.setattr("pkg.services.foundation.connectors.asyncio.sleep", fake_sleep)

    papers = await search_arxiv(query="agentic rag", retries=1)

    assert papers == []
    assert calls == 2
    assert 7.0 in sleeps


@pytest.mark.asyncio
async def test_search_arxiv_does_not_retry_429_without_retry_after(monkeypatch):
    calls = 0
    sleeps: list[float] = []

    class Response:
        status_code = 429
        text = ""
        headers = {}

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            nonlocal calls
            calls += 1
            return Response()

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)
    monkeypatch.setattr("pkg.services.foundation.connectors.asyncio.sleep", fake_sleep)

    with pytest.raises(ArxivRateLimitError, match="arXiv rate limit exceeded"):
        await search_arxiv(query="agentic rag", retries=2)

    assert calls == 3
    assert any(delay > 0 for delay in sleeps)


@pytest.mark.asyncio
async def test_search_arxiv_uses_configured_user_agent(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        text = '<feed xmlns="http://www.w3.org/2005/Atom" />'
        headers = {}

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            captured["headers"] = kwargs.get("headers")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            return Response()

    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)
    monkeypatch.setattr("pkg.services.foundation.connectors.settings.ARXIV_USER_AGENT", "pkg-test/1.0")

    await search_arxiv(query="agentic rag")

    assert captured["headers"] == {"User-Agent": "pkg-test/1.0"}


@pytest.mark.asyncio
async def test_search_github_defaults_to_past_year(monkeypatch):
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"items": []}

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            captured["params"] = params
            return Response()

    monkeypatch.setattr("pkg.services.foundation.connectors.one_year_ago_date", lambda: "2025-05-28")
    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)

    await search_github_repos(query="agent framework")

    assert captured["params"]["q"] == "agent framework pushed:>=2025-05-28"


@pytest.mark.asyncio
async def test_import_arxiv_paper_creates_source_with_metadata():
    mock_session = AsyncMock()
    mock_session.get.return_value = None
    paper = ArxivPaper(
        arxiv_id="2401.12345v1",
        title="Test Paper",
        authors=["Alice"],
        abstract="Abstract text",
        categories=["cs.AI"],
        published=datetime(2024, 1, 2, tzinfo=timezone.utc),
        updated=datetime(2024, 1, 3, tzinfo=timezone.utc),
        pdf_url="https://arxiv.org/pdf/2401.12345v1",
        entry_url="https://arxiv.org/abs/2401.12345v1",
        doi="10.123/test",
    )
    mock_source = MagicMock()
    mock_source.id = "src-arxiv-2401.12345v1"

    with patch("pkg.services.foundation.connectors.persist_source", new_callable=AsyncMock, return_value=mock_source) as mock_persist:
        source, created, dedupe_key = await import_arxiv_paper(mock_session, user_id="user-1", paper=paper)

    assert source is mock_source
    assert created is True
    assert dedupe_key == "arxiv:2401.12345v1"
    body = mock_persist.await_args.kwargs["body"]
    assert body.id == "src-arxiv-2401.12345v1"
    assert body.source_type == "article"
    assert body.metadata["review_status"] == "imported_reviewable"
    assert body.metadata["retention"] == "permanent"
    assert body.metadata["kept_at"]


@pytest.mark.asyncio
async def test_import_github_repo_updates_existing_source():
    existing = MagicMock()
    existing.user_id = "user-1"
    existing.metadata_ = {"old": True}
    mock_session = AsyncMock()
    mock_session.get.return_value = existing
    repo = GitHubRepo(
        full_name="openai/codex",
        owner="openai",
        name="codex",
        description="Coding agent",
        topics=["agents"],
        language="TypeScript",
        stars=100,
        forks=10,
        default_branch="main",
        clone_url="https://github.com/openai/codex.git",
        html_url="https://github.com/openai/codex",
        license="Apache-2.0",
        readme="# README",
    )

    with (
        patch("pkg.services.foundation.connectors.upsert_source_memory_node", new_callable=AsyncMock) as mock_memory,
        patch("pkg.services.foundation.connectors.upsert_source_embeddings", new_callable=AsyncMock) as mock_embeddings,
    ):
        source, created, dedupe_key = await import_github_repo(mock_session, user_id="user-1", repo=repo)

    assert source is existing
    assert created is False
    assert dedupe_key == "github:openai/codex"
    assert existing.source_type == "github"
    assert existing.url == "https://github.com/openai/codex"
    assert existing.metadata_["connector"] == "github"
    assert existing.metadata_["retention"] == "permanent"
    assert existing.metadata_["kept_at"]
    assert existing.metadata_["embedding_strategy"] == "github_repo_summary_v1"
    assert "GitHub repository: openai/codex" in existing.metadata_["embedding_text"]
    assert "Language: TypeScript" in existing.metadata_["embedding_text"]
    assert "Topics: agents" in existing.metadata_["embedding_text"]
    mock_embeddings.assert_awaited_once_with(mock_session, existing)
    mock_memory.assert_awaited_once_with(mock_session, existing)


def test_canonicalize_news_url_removes_tracking_params():
    url = "https://Example.com/story?a=1&utm_source=x&fbclid=abc#section"
    assert _canonicalize_news_url(url) == "https://example.com/story?a=1"


@pytest.mark.asyncio
async def test_search_news_articles_maps_newsapi_payload(monkeypatch):
    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "articles": [
                    {
                        "source": {"name": "Example News"},
                        "author": "Jane Doe",
                        "title": "Test headline",
                        "description": "Summary",
                        "content": "Body",
                        "url": "https://example.com/news/1",
                        "urlToImage": "https://example.com/img.jpg",
                        "publishedAt": "2026-06-20T12:00:00Z",
                    }
                ]
            }

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            return Response()

    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)

    items = await search_news_articles(query="openai", language="en", max_results=5)

    assert len(items) == 1
    assert items[0].provider == "newsapi"
    assert items[0].source_name == "Example News"
    assert items[0].title == "Test headline"
    assert items[0].language == "en"


@pytest.mark.asyncio
async def test_search_news_articles_raises_rate_limit(monkeypatch):
    class Response:
        status_code = 429

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            return Response()

    monkeypatch.setattr("pkg.services.foundation.connectors.httpx.AsyncClient", Client)

    with pytest.raises(NewsRateLimitError):
        await search_news_articles(query="openai")


@pytest.mark.asyncio
async def test_import_news_article_creates_article_source_with_news_metadata():
    mock_session = AsyncMock()
    mock_session.get.return_value = None
    article = NewsArticle(
        provider="newsapi",
        title="OpenAI launches feature",
        url="https://example.com/story?utm_source=newsletter",
        source_name="Example News",
        author="Jane Doe",
        description="Summary",
    )
    mock_source = MagicMock()
    mock_source.id = "src-news-newsapi-example"

    with (
        patch("pkg.services.foundation.connectors.persist_source", new_callable=AsyncMock, return_value=mock_source) as mock_persist,
        patch("pkg.services.foundation.connectors.fetch_web_page", new_callable=AsyncMock, side_effect=Exception("skip")),
    ):
        source, created, dedupe_key = await import_news_article(mock_session, user_id="user-1", article=article, fetch_full_text=False)

    assert source is mock_source
    assert created is True
    assert dedupe_key == "newsapi:https://example.com/story"
    body = mock_persist.await_args.kwargs["body"]
    assert body.source_type == "article"
    assert body.metadata["kind"] == "news"
    assert body.metadata["provider"] == "newsapi"
    assert body.url == "https://example.com/story"


@pytest.mark.asyncio
async def test_news_search_api_returns_cached_items(fake_user, mock_session, monkeypatch):
    from pkg.api import connectors as connectors_api
    from pkg.schemas.connector import NewsSearchRequest

    article = NewsArticle(provider="newsapi", title="Headline", url="https://example.com/news/1")

    async def fake_search_news_articles(**kwargs):
        return [article]

    class CacheRow:
        id = 1
        status = "cached"
        expires_at = None
        source_id = None

    async def fake_upsert_connector_search_items(*args, **kwargs):
        return {"https://example.com/news/1": CacheRow()}

    monkeypatch.setattr(connectors_api, "search_news_articles", fake_search_news_articles)
    monkeypatch.setattr(connectors_api, "upsert_connector_search_items", fake_upsert_connector_search_items)

    response = await connectors_api.search_news_connector(
        NewsSearchRequest(query="openai", max_results=3),
        user=fake_user,
        session=mock_session,
    )

    assert response.total == 1
    assert response.items[0].cache_status == "cached"


@pytest.mark.asyncio
async def test_news_import_api_imports_article(fake_user, mock_session, monkeypatch):
    from pkg.api import connectors as connectors_api
    from pkg.schemas.connector import NewsImportRequest
    from pkg.models.source import Source

    article = NewsArticle(provider="newsapi", title="Headline", url="https://example.com/news/1")
    source = Source(
        id="src-news-newsapi-example",
        user_id="test-user-001",
        category_id=1,
        title="Headline",
        source_type="article",
        url="https://example.com/news/1",
        raw_content="body",
        metadata_={},
        ingested_at=datetime.now(timezone.utc),
    )

    async def fake_import_news_article(*args, **kwargs):
        return source, True, "newsapi:https://example.com/news/1"

    async def fake_mark_connector_item_saved(*args, **kwargs):
        return None

    monkeypatch.setattr(connectors_api, "import_news_article", fake_import_news_article)
    monkeypatch.setattr(connectors_api, "mark_connector_item_saved", fake_mark_connector_item_saved)

    response = await connectors_api.import_news_connector(
        NewsImportRequest(article=article),
        user=fake_user,
        session=mock_session,
    )

    assert response.created is True
    assert response.dedupe_key == "newsapi:https://example.com/news/1"


@pytest.mark.asyncio
async def test_arxiv_search_api_uses_no_retry_for_manual_search(fake_user, mock_session, monkeypatch):
    from pkg.api import connectors as connectors_api
    from pkg.schemas.connector import ArxivSearchRequest

    captured = {}

    async def fake_search_arxiv(**kwargs):
        captured.update(kwargs)
        return []

    async def fake_upsert_connector_search_items(*args, **kwargs):
        return {}

    async def fake_generate_discovery_items(*args, **kwargs):
        return 0, 0, 0

    monkeypatch.setattr(connectors_api, "search_arxiv", fake_search_arxiv)
    monkeypatch.setattr(connectors_api, "upsert_connector_search_items", fake_upsert_connector_search_items)
    monkeypatch.setattr(connectors_api, "generate_discovery_items", fake_generate_discovery_items)

    response = await connectors_api.search_arxiv_connector(
        ArxivSearchRequest(query="agentic rag", max_results=3),
        user=fake_user,
        session=mock_session,
    )

    assert response.total == 0
    assert captured["retries"] == 0
    assert captured["query"] == "agentic rag"
    assert captured["max_results"] == 3


@pytest.mark.asyncio
async def test_arxiv_import_lookup_uses_no_retry_for_manual_paper_id(fake_user, mock_session, monkeypatch):
    from pkg.api import connectors as connectors_api
    from pkg.schemas.connector import ArxivImportRequest

    captured = {}
    paper = ArxivPaper(arxiv_id="2401.12345v1", title="Test", abstract="Abstract", authors=[], categories=[])
    from pkg.models.source import Source

    source = Source(
        id="src-arxiv-2401.12345v1",
        user_id="test-user-001",
        category_id=1,
        title="Test",
        source_type="article",
        url="https://arxiv.org/abs/2401.12345v1",
        raw_content="Abstract",
        metadata_={},
        ingested_at=datetime.now(timezone.utc),
    )

    async def fake_search_arxiv(**kwargs):
        captured.update(kwargs)
        return [paper]

    async def fake_import_arxiv_paper(*args, **kwargs):
        return source, True, "arxiv:2401.12345v1"

    async def fake_mark_connector_item_saved(*args, **kwargs):
        return None

    monkeypatch.setattr(connectors_api, "search_arxiv", fake_search_arxiv)
    monkeypatch.setattr(connectors_api, "import_arxiv_paper", fake_import_arxiv_paper)
    monkeypatch.setattr(connectors_api, "mark_connector_item_saved", fake_mark_connector_item_saved)

    response = await connectors_api.import_arxiv_connector(
        ArxivImportRequest(paper_id="2401.12345v1"),
        user=fake_user,
        session=mock_session,
    )

    assert response.created is True
    assert captured["retries"] == 0
    assert captured["paper_id"] == "2401.12345v1"
    assert captured["max_results"] == 1
