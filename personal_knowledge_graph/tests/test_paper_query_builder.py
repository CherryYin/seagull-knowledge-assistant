from types import SimpleNamespace

from pkg.services.foundation.paper_query_builder import build_paper_query_bundle


def make_profile(**overrides):
    base = {
        "name": "Agents Radar",
        "goal_prompt": "关注 AI agents、memory、tool use，排除 robotics",
        "mode": "hybrid",
        "provider": "semantic_scholar",
        "include_terms": ["agent memory", "tool use"],
        "exclude_terms": ["robotics"],
        "preferred_authors": ["Shunyu Yao"],
        "preferred_venues": ["NeurIPS"],
        "preferred_fields": ["Computer Science"],
        "time_window_days": 90,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_build_paper_query_bundle_creates_primary_and_expanded_queries():
    bundle = build_paper_query_bundle(make_profile())

    assert bundle.profile_name == "Agents Radar"
    assert bundle.mode == "hybrid"
    assert bundle.primary_queries
    assert bundle.expanded_queries
    assert bundle.primary_queries[0].provider == "semantic_scholar"
    assert "agent memory" in bundle.primary_queries[0].query
    assert '-robotics' in bundle.primary_queries[0].query
    assert bundle.date_filters == {"time_window_days": 90}


def test_build_paper_query_bundle_uses_goal_prompt_when_include_terms_missing():
    bundle = build_paper_query_bundle(
        make_profile(include_terms=[], preferred_authors=[], preferred_venues=[], preferred_fields=[], mode="query")
    )

    assert bundle.primary_queries
    assert "AI agents" in bundle.primary_queries[0].query or "memory" in bundle.primary_queries[0].query
    assert bundle.trend_queries == []


def test_build_paper_query_bundle_adds_trend_seed_for_hybrid_mode():
    bundle = build_paper_query_bundle(make_profile(mode="hybrid"))

    assert len(bundle.trend_queries) == 1
    assert "trend" in bundle.trend_queries[0].query
