from types import SimpleNamespace

import pytest

from pkg.services.foundation.paper_discovery import execute_profile_run


class FakeSession:
    def __init__(self, profile):
        self.profile = profile
        self.added = []
        self.flushed = False
        self.committed = False

    async def execute(self, _query):
        return SimpleNamespace(scalar_one_or_none=lambda: self.profile)

    def add(self, item):
        if getattr(item, "id", None) is None and item.__class__.__name__ == "PaperDiscoveryRun":
            item.id = 99
        self.added.append(item)

    async def flush(self):
        self.flushed = True

    async def commit(self):
        self.committed = True


@pytest.mark.asyncio
async def test_execute_profile_run_creates_candidates_and_stats(monkeypatch):
    profile = SimpleNamespace(
        id=1,
        user_id="user-1",
        name="Agents Radar",
        mode="query",
        provider="semantic_scholar",
        max_results=5,
        include_terms=["agent memory"],
        exclude_terms=["robotics"],
        preferred_authors=[],
        preferred_venues=[],
        preferred_fields=[],
        discovery_window_days=365,
        time_window_days=30,
        goal_prompt="agent memory",
        last_run_at=None,
    )
    session = FakeSession(profile)

    async def fake_search_papers_with_fallback(*, query, limit, window_days):
        return [
            SimpleNamespace(
                provider="openalex",
                provider_id="paper-1",
                title="Agent Memory Systems",
                abstract="summary",
                authors=["Alice"],
                url="https://example.org/p1",
                pdf_url=None,
                doi=None,
                arxiv_id="2501.12345",
                fields_of_study=["Computer Science"],
                citation_count=10,
                reference_count=20,
                venue="arXiv",
                year=2026,
                metadata={"external_ids": {"ArXiv": "2501.12345"}},
            )
        ]

    async def fake_load_profile(_session, _user_id):
        return {}

    async def fake_get_seen_item(_session, *, user_id, profile_id, provider, item_key):
        return None

    async def fake_mark_seen_item(_session, **kwargs):
        return SimpleNamespace(id=1)

    async def fake_upsert_discovery_item(_session, *, user_id, candidate, profile):
        return SimpleNamespace(id=1, title=candidate["title"], payload=candidate["payload"]), True

    monkeypatch.setattr("pkg.services.foundation.paper_discovery._search_papers_with_fallback", fake_search_papers_with_fallback)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._load_profile", fake_load_profile)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.get_seen_item", fake_get_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.mark_seen_item", fake_mark_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._upsert_discovery_item", fake_upsert_discovery_item)

    run, items, created, updated = await execute_profile_run(session, user_id="user-1", profile_id=1)

    assert run.status == "completed"
    assert run.stats["queries_executed"] >= 1
    assert created >= 1
    assert updated == 0
    assert len(items) == created
    assert session.committed is True
    assert run.stats["seen_filtered"] == 0


@pytest.mark.asyncio
async def test_execute_profile_run_dedupes_same_paper_from_multiple_queries(monkeypatch):
    profile = SimpleNamespace(
        id=1,
        user_id="user-1",
        name="Agents Radar",
        mode="query",
        provider="semantic_scholar",
        max_results=5,
        include_terms=["agent memory", "tool use"],
        exclude_terms=[],
        preferred_authors=[],
        preferred_venues=[],
        preferred_fields=[],
        discovery_window_days=365,
        time_window_days=None,
        goal_prompt=None,
        last_run_at=None,
    )
    session = FakeSession(profile)
    upserted = []

    async def fake_search_papers_with_fallback(*, query, limit, window_days):
        return [
            SimpleNamespace(
                provider="openalex",
                provider_id="paper-1",
                title="Agent Memory Systems",
                abstract="summary",
                authors=["Alice"],
                url="https://example.org/p1",
                pdf_url=None,
                doi=None,
                arxiv_id="2501.12345",
                fields_of_study=["Computer Science"],
                citation_count=10,
                reference_count=20,
                venue="arXiv",
                year=2026,
                metadata={"external_ids": {"ArXiv": "2501.12345"}},
            )
        ]

    async def fake_load_profile(_session, _user_id):
        return {}

    async def fake_get_seen_item(_session, *, user_id, profile_id, provider, item_key):
        return None

    async def fake_mark_seen_item(_session, **kwargs):
        return SimpleNamespace(id=1)

    async def fake_upsert_discovery_item(_session, *, user_id, candidate, profile):
        upserted.append(candidate)
        return SimpleNamespace(id=len(upserted), title=candidate["title"], payload=candidate["payload"]), True

    monkeypatch.setattr("pkg.services.foundation.paper_discovery._search_papers_with_fallback", fake_search_papers_with_fallback)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._load_profile", fake_load_profile)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.get_seen_item", fake_get_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.mark_seen_item", fake_mark_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._upsert_discovery_item", fake_upsert_discovery_item)

    run, items, created, updated = await execute_profile_run(session, user_id="user-1", profile_id=1)

    assert run.stats["candidates_found"] >= 2
    assert run.stats["candidates_deduped"] == 1
    assert len(upserted) == 1
    assert created == 1
    assert updated == 0


@pytest.mark.asyncio
async def test_execute_profile_run_trend_mode_creates_snapshots_without_query_candidates(monkeypatch):
    profile = SimpleNamespace(
        id=1,
        user_id="user-1",
        name="Agents Radar",
        mode="trend",
        provider="semantic_scholar",
        max_results=5,
        include_terms=["agent memory"],
        exclude_terms=[],
        preferred_authors=[],
        preferred_venues=[],
        preferred_fields=[],
        discovery_window_days=365,
        time_window_days=30,
        goal_prompt="agent memory",
        last_run_at=None,
    )
    session = FakeSession(profile)

    async def fake_find_paper_trends(_session, *, profile, commit):
        return [SimpleNamespace(term="memory"), SimpleNamespace(term="agent")]

    async def fake_load_profile(_session, _user_id):
        return {}

    async def fake_get_seen_item(_session, *, user_id, profile_id, provider, item_key):
        return None

    async def fake_upsert_discovery_item(_session, *, user_id, candidate, profile):
        raise AssertionError("trend mode should not upsert query candidates")

    monkeypatch.setattr("pkg.services.foundation.paper_discovery.find_paper_trends", fake_find_paper_trends)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._load_profile", fake_load_profile)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.get_seen_item", fake_get_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._upsert_discovery_item", fake_upsert_discovery_item)

    run, items, created, updated = await execute_profile_run(session, user_id="user-1", profile_id=1)

    assert run.status == "completed"
    assert run.stats["mode"] == "trend"
    assert run.stats["trend_snapshots"] == 2
    assert run.stats["candidates_found"] == 0
    assert items == []
    assert created == 0
    assert updated == 0


@pytest.mark.asyncio
async def test_execute_profile_run_hybrid_mode_runs_queries_and_trends(monkeypatch):
    profile = SimpleNamespace(
        id=1,
        user_id="user-1",
        name="Agents Radar",
        mode="hybrid",
        provider="semantic_scholar",
        max_results=5,
        include_terms=["agent memory"],
        exclude_terms=[],
        preferred_authors=[],
        preferred_venues=[],
        preferred_fields=[],
        discovery_window_days=365,
        time_window_days=30,
        goal_prompt="agent memory",
        last_run_at=None,
    )
    session = FakeSession(profile)

    async def fake_search_papers_with_fallback(*, query, limit, window_days):
        return [
            SimpleNamespace(
                provider="openalex",
                provider_id="paper-1",
                title="Agent Memory Systems",
                abstract="summary",
                authors=["Alice"],
                url="https://example.org/p1",
                pdf_url=None,
                doi=None,
                arxiv_id="2501.12345",
                fields_of_study=["Computer Science"],
                citation_count=10,
                reference_count=20,
                venue="arXiv",
                year=2026,
                metadata={"external_ids": {"ArXiv": "2501.12345"}},
            )
        ]

    async def fake_find_paper_trends(_session, *, profile, commit):
        return [SimpleNamespace(term="memory")]

    async def fake_load_profile(_session, _user_id):
        return {}

    async def fake_get_seen_item(_session, *, user_id, profile_id, provider, item_key):
        return None

    async def fake_mark_seen_item(_session, **kwargs):
        return SimpleNamespace(id=1)

    async def fake_upsert_discovery_item(_session, *, user_id, candidate, profile):
        return SimpleNamespace(id=1, title=candidate["title"], payload=candidate["payload"]), True

    monkeypatch.setattr("pkg.services.foundation.paper_discovery._search_papers_with_fallback", fake_search_papers_with_fallback)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.find_paper_trends", fake_find_paper_trends)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._load_profile", fake_load_profile)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.get_seen_item", fake_get_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.mark_seen_item", fake_mark_seen_item)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery._upsert_discovery_item", fake_upsert_discovery_item)

    run, items, created, updated = await execute_profile_run(session, user_id="user-1", profile_id=1)

    assert run.status == "completed"
    assert run.stats["mode"] == "hybrid"
    assert run.stats["trend_snapshots"] == 1
    assert created >= 1


@pytest.mark.asyncio
async def test_execute_profile_run_filters_seen_items(monkeypatch):
    profile = SimpleNamespace(
        id=1,
        user_id="user-1",
        name="Agents Radar",
        mode="query",
        provider="semantic_scholar",
        max_results=5,
        include_terms=["agent memory"],
        exclude_terms=[],
        preferred_authors=[],
        preferred_venues=[],
        preferred_fields=[],
        discovery_window_days=365,
        time_window_days=30,
        goal_prompt="agent memory",
        last_run_at=None,
    )
    session = FakeSession(profile)

    async def fake_search_papers_with_fallback(*, query, limit, window_days):
        return [
            SimpleNamespace(
                provider="openalex",
                provider_id="paper-1",
                title="Agent Memory Systems",
                abstract="summary",
                authors=["Alice"],
                url="https://example.org/p1",
                pdf_url=None,
                doi=None,
                arxiv_id="2501.12345",
                fields_of_study=["Computer Science"],
                citation_count=10,
                reference_count=20,
                venue="arXiv",
                year=2026,
                metadata={"external_ids": {"ArXiv": "2501.12345"}},
            )
        ]

    async def fake_load_profile(_session, _user_id):
        return {}

    async def fake_get_seen_item(_session, *, user_id, profile_id, provider, item_key):
        return SimpleNamespace(id=1)

    async def fake_mark_seen_item(_session, **kwargs):
        raise AssertionError("seen items should not be marked again")

    async def fake_upsert_discovery_item(_session, *, user_id, candidate, profile):
        raise AssertionError("seen items should be filtered before upsert")

    monkeypatch.setattr("pkg.services.foundation.paper_discovery._search_papers_with_fallback", fake_search_papers_with_fallback)


@pytest.mark.asyncio
async def test_search_fallback_uses_crossref_when_openalex_fails(monkeypatch):
    from pkg.services.foundation.paper_discovery import _search_papers_with_fallback

    async def fake_search_openalex(*, query, limit, from_year):
        raise RuntimeError("openalex down")

    async def fake_search_crossref(*, query, limit):
        return [SimpleNamespace(provider="crossref", provider_id="doi:1", title="Fallback paper", abstract=None, authors=[], url=None, pdf_url=None, doi="10.1/x", arxiv_id=None, fields_of_study=[], citation_count=None, reference_count=None, venue=None, year=2026, metadata=None)]

    monkeypatch.setattr("pkg.services.foundation.paper_discovery.search_openalex", fake_search_openalex)
    monkeypatch.setattr("pkg.services.foundation.paper_discovery.search_crossref", fake_search_crossref)

    papers = await _search_papers_with_fallback(query="agent memory", limit=3, window_days=365)

    assert len(papers) == 1
    assert papers[0].provider == "crossref"
