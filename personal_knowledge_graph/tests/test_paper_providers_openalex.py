import pytest

from pkg.services.paper_providers.openalex import search_openalex


@pytest.mark.asyncio
async def test_search_openalex_normalizes_results(monkeypatch):
    captured: dict = {}

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {
                        "id": "https://openalex.org/W123",
                        "display_name": "Agent Memory Systems",
                        "publication_date": "2026-05-01",
                        "publication_year": 2026,
                        "doi": "https://doi.org/10.1000/test",
                        "ids": {"arxiv": "https://arxiv.org/abs/2501.12345"},
                        "authorships": [{"author": {"display_name": "Alice"}}],
                        "concepts": [{"display_name": "Computer Science"}],
                        "primary_location": {"landing_page_url": "https://example.org/p1", "source": {"display_name": "arXiv"}},
                        "cited_by_count": 12,
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

        async def get(self, url, params=None):
            captured["url"] = url
            captured["params"] = params or {}
            return Response()

    monkeypatch.setattr("pkg.services.paper_providers.openalex.httpx.AsyncClient", Client)
    monkeypatch.setattr("pkg.services.paper_providers.openalex.settings.OPENALEX_API_KEY", "openalex-test-key")

    papers = await search_openalex(query="agent memory", limit=3, from_year=2025)

    assert len(papers) == 1
    assert papers[0].provider == "openalex"
    assert papers[0].doi == "10.1000/test"
    assert papers[0].arxiv_id == "2501.12345"
    assert captured["params"]["api_key"] == "openalex-test-key"
    assert "mailto" not in captured["params"]
