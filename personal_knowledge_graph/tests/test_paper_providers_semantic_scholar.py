import pytest

from pkg.services.paper_providers.semantic_scholar import (
    SemanticScholarRateLimitError,
    lookup_semantic_scholar_by_arxiv_id,
    search_semantic_scholar,
)


@pytest.mark.asyncio
async def test_search_semantic_scholar_normalizes_results(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        headers = {}

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "data": [
                    {
                        "paperId": "abc123",
                        "title": "Agent Memory Systems",
                        "abstract": "Test abstract",
                        "authors": [{"name": "Alice"}, {"name": "Bob"}],
                        "publicationDate": "2026-05-01",
                        "year": 2026,
                        "url": "https://example.org/paper",
                        "venue": "arXiv",
                        "citationCount": 12,
                        "referenceCount": 30,
                        "fieldsOfStudy": ["Computer Science"],
                        "externalIds": {"ArXiv": "2501.12345", "DOI": "10.1000/test"},
                        "openAccessPdf": {"url": "https://example.org/paper.pdf"},
                    }
                ]
            }

    class Client:
        def __init__(self, *args, **kwargs):
            captured["headers"] = kwargs.get("headers")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params=None):
            captured["url"] = url
            captured["params"] = params
            return Response()

    monkeypatch.setattr("pkg.services.paper_providers.semantic_scholar.httpx.AsyncClient", Client)

    papers = await search_semantic_scholar(query="agent memory", limit=5)

    assert len(papers) == 1
    assert papers[0].provider == "semantic_scholar"
    assert papers[0].provider_id == "abc123"
    assert papers[0].arxiv_id == "2501.12345"
    assert papers[0].doi == "10.1000/test"
    assert papers[0].authors == ["Alice", "Bob"]
    assert captured["params"]["query"] == "agent memory"
    assert captured["params"]["limit"] == 5


@pytest.mark.asyncio
async def test_lookup_semantic_scholar_by_arxiv_id_uses_arxiv_prefix(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        headers = {}

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "paperId": "abc123",
                "title": "Agent Memory Systems",
                "authors": [],
                "externalIds": {"ArXiv": "2501.12345"},
            }

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params=None):
            captured["url"] = url
            return Response()

    monkeypatch.setattr("pkg.services.paper_providers.semantic_scholar.httpx.AsyncClient", Client)

    paper = await lookup_semantic_scholar_by_arxiv_id("2501.12345")

    assert paper is not None
    assert captured["url"].endswith("/paper/ARXIV:2501.12345")


@pytest.mark.asyncio
async def test_search_semantic_scholar_raises_rate_limit_after_retries(monkeypatch):
    class Response:
        status_code = 429
        headers = {"Retry-After": "1"}

        def raise_for_status(self):
            return None

        def json(self):
            return {}

    class Client:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params=None):
            return Response()

    async def fake_sleep(_delay):
        return None

    monkeypatch.setattr("pkg.services.paper_providers.semantic_scholar.httpx.AsyncClient", Client)
    monkeypatch.setattr("pkg.services.paper_providers.semantic_scholar.asyncio.sleep", fake_sleep)

    with pytest.raises(SemanticScholarRateLimitError):
        await search_semantic_scholar(query="agent memory")
