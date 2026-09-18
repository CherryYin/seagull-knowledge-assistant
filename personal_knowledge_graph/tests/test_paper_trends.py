from collections import Counter
from types import SimpleNamespace

import pytest

from pkg.services.foundation.paper_trends import extract_trend_terms, find_paper_trends, score_trend_terms


def make_paper(title: str, abstract: str = "", fields=None):
    return SimpleNamespace(title=title, abstract=abstract, fields_of_study=fields or ["Computer Science"])


def test_extract_trend_terms_counts_repeated_keywords():
    papers = [
        make_paper("Agent memory systems", "Memory for agents"),
        make_paper("Tool use for agent systems", "Agent tool use"),
        make_paper("Memory planning in agents", "Planning and memory"),
    ]

    terms = extract_trend_terms(papers, top_k=10, min_count=2)

    assert terms["agent"] >= 2
    assert terms["memory"] >= 2


def test_score_trend_terms_prefers_fast_growth():
    current = Counter({"memory": 6, "agent": 5, "benchmark": 2})
    baseline = Counter({"memory": 2, "agent": 5, "benchmark": 1})

    scored = score_trend_terms(current, baseline)

    assert scored[0]["term"] == "memory"
    assert scored[0]["growth_rate"] > 1


@pytest.mark.asyncio
async def test_find_paper_trends_persists_ranked_snapshots(monkeypatch):
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
        time_window_days=30,
        goal_prompt="agent memory",
    )
    added = []

    class FakeSession:
        async def execute(self, _query):
            return SimpleNamespace(scalar_one_or_none=lambda: None)

        def add(self, item):
            added.append(item)

        async def commit(self):
            return None

    async def fake_collect_trend_corpus(profile, *, current_days, baseline_days, limit_per_query=None):
        current = [
            make_paper("Agent memory systems", "Memory for agents"),
            make_paper("Agent memory planning", "Planning for agents"),
            make_paper("Agent memory benchmark", "Benchmark for agents"),
        ]
        baseline = [make_paper("Agent planning", "Planning")]
        return current, baseline, ["agent memory"]

    monkeypatch.setattr("pkg.services.foundation.paper_trends.collect_trend_corpus", fake_collect_trend_corpus)

    snapshots = await find_paper_trends(FakeSession(), profile=profile, top_k=3)

    assert snapshots
    assert added
    assert snapshots[0].term in {"agent", "memory"}
