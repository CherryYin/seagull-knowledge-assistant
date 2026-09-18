from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from pkg.models.github_trend_profile import GitHubTrendProfile
from pkg.schemas.connector import ArxivPaper, GitHubRepo
from pkg.services.foundation.connector_trends import (
    score_arxiv_paper,
    score_github_repo,
    collect_arxiv_trends_for_user,
    collect_daily_connector_trends,
    collect_daily_github_trends,
    collect_github_trends_for_profile,
    collect_github_trends_for_user,
    run_scheduled_github_trend_profiles,
    should_run_github_trend_profile,
)


def test_arxiv_score_uses_citations_and_recency():
    recent = ArxivPaper(
        arxiv_id="2401.1",
        title="Recent",
        authors=[],
        abstract="",
        categories=[],
        published=datetime.now(timezone.utc) - timedelta(days=2),
    )
    old = ArxivPaper(
        arxiv_id="2001.1",
        title="Old",
        authors=[],
        abstract="",
        categories=[],
        published=datetime.now(timezone.utc) - timedelta(days=1200),
    )
    assert score_arxiv_paper(recent, citation_count=10) > score_arxiv_paper(old, citation_count=10)
    assert score_arxiv_paper(old, citation_count=1000) > score_arxiv_paper(old, citation_count=10)


def test_github_score_prefers_recent_growth_when_history_exists():
    repo = GitHubRepo(
        full_name="owner/repo",
        owner="owner",
        name="repo",
        html_url="https://github.com/owner/repo",
        stars=120,
        forks=30,
    )
    assert score_github_repo(repo, previous_stars=100, previous_forks=20) == 40
    assert score_github_repo(repo) > 0


@pytest.mark.asyncio
async def test_collect_arxiv_trends_imports_top_ranked_items():
    session = AsyncMock()
    session.add = MagicMock()
    paper_a = ArxivPaper(arxiv_id="2401.1", title="A", authors=[], abstract="", categories=[], published=datetime.now(timezone.utc))
    paper_b = ArxivPaper(arxiv_id="2001.1", title="B", authors=[], abstract="", categories=[], published=datetime.now(timezone.utc) - timedelta(days=1000))
    source = MagicMock()
    source.id = "src-arxiv-2401.1"
    rows = MagicMock()
    rows.scalar_one_or_none.return_value = None
    session.execute.return_value = rows

    with patch("pkg.services.foundation.connector_trends.search_arxiv", new_callable=AsyncMock, return_value=[paper_b, paper_a]) as mock_search, \
         patch("pkg.services.foundation.connector_trends.fetch_arxiv_citation_count", new_callable=AsyncMock, side_effect=[50]), \
         patch("pkg.services.foundation.connector_trends.import_arxiv_paper", new_callable=AsyncMock, return_value=(source, True, "arxiv:2401.1")):
        items = await collect_arxiv_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert mock_search.await_args.kwargs["date_from"]

    assert len(items) == 1
    assert items[0].provider == "arxiv"
    assert items[0].rank == 1
    assert items[0].metadata_["citation_count"] == 50


@pytest.mark.asyncio
async def test_collect_arxiv_trends_skips_timeout_without_importing():
    session = AsyncMock()

    with patch(
        "pkg.services.foundation.connector_trends.search_arxiv",
        new_callable=AsyncMock,
        side_effect=httpx.ReadTimeout("arXiv read timed out"),
    ), patch("pkg.services.foundation.connector_trends.import_arxiv_paper", new_callable=AsyncMock) as mock_import:
        items = await collect_arxiv_trends_for_user(session, user_id="user-1", trend_date="2026-05-22")

    assert items == []
    mock_import.assert_not_called()


@pytest.mark.asyncio
async def test_collect_github_trends_uses_growth_snapshot():
    session = AsyncMock()
    session.add = MagicMock()
    previous = MagicMock()
    previous.metadata_ = {"stars": 100, "forks": 10}
    previous_rows = MagicMock()
    previous_rows.scalar_one_or_none.return_value = previous
    empty_rows = MagicMock()
    empty_rows.scalar_one_or_none.return_value = None
    session.execute.side_effect = [previous_rows, empty_rows]
    repo = GitHubRepo(full_name="owner/repo", owner="owner", name="repo", html_url="https://github.com/owner/repo", stars=130, forks=15, pushed_at=datetime.now(timezone.utc))
    source = MagicMock()
    source.id = "src-github-owner-repo"

    with patch("pkg.services.foundation.connector_trends.search_github_repos", new_callable=AsyncMock, return_value=[repo]) as mock_search, \
         patch("pkg.services.foundation.connector_trends.get_github_repo", new_callable=AsyncMock, return_value=repo), \
         patch("pkg.services.foundation.connector_trends.import_github_repo", new_callable=AsyncMock, return_value=(source, True, "github:owner/repo")):
        items = await collect_github_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert mock_search.await_args.kwargs["pushed_after"]

    assert len(items) == 1
    assert items[0].provider == "github"
    assert items[0].metadata_["star_growth_7d"] == 30
    assert items[0].metadata_["fork_growth_7d"] == 5


@pytest.mark.asyncio
async def test_collect_github_trends_uses_user_settings_query_override():
    session = AsyncMock()
    session.add = MagicMock()
    session.execute.side_effect = [MagicMock(scalar_one_or_none=MagicMock(return_value=None)), MagicMock(scalar_one_or_none=MagicMock(return_value=None))]
    repo = GitHubRepo(full_name="owner/repo", owner="owner", name="repo", html_url="https://github.com/owner/repo", stars=130, forks=15, pushed_at=datetime.now(timezone.utc))
    source = MagicMock()
    source.id = "src-github-owner-repo"

    with patch("pkg.services.foundation.connector_trends.get_user_setting_str", new_callable=AsyncMock, return_value="custom agent query") as mock_setting, \
         patch("pkg.services.foundation.connector_trends.search_github_repos", new_callable=AsyncMock, return_value=[repo]) as mock_search, \
         patch("pkg.services.foundation.connector_trends.get_github_repo", new_callable=AsyncMock, return_value=repo), \
         patch("pkg.services.foundation.connector_trends.import_github_repo", new_callable=AsyncMock, return_value=(source, True, "github:owner/repo")):
        await collect_github_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    mock_setting.assert_awaited_once()
    assert mock_search.await_args.kwargs["query"] == "custom agent query"


@pytest.mark.asyncio
async def test_collect_github_trends_passes_user_id_to_repo_search_and_lookup():
    session = AsyncMock()
    session.add = MagicMock()
    session.execute.side_effect = [MagicMock(scalar_one_or_none=MagicMock(return_value=None)), MagicMock(scalar_one_or_none=MagicMock(return_value=None))]
    repo = GitHubRepo(full_name="owner/repo", owner="owner", name="repo", html_url="https://github.com/owner/repo", stars=130, forks=15, pushed_at=datetime.now(timezone.utc))
    source = MagicMock()
    source.id = "src-github-owner-repo"

    with patch("pkg.services.foundation.connector_trends.get_user_setting_str", new_callable=AsyncMock, return_value="custom agent query"), \
         patch("pkg.services.foundation.connector_trends.search_github_repos", new_callable=AsyncMock, return_value=[repo]) as mock_search, \
         patch("pkg.services.foundation.connector_trends.get_github_repo", new_callable=AsyncMock, return_value=repo) as mock_get_repo, \
         patch("pkg.services.foundation.connector_trends.import_github_repo", new_callable=AsyncMock, return_value=(source, True, "github:owner/repo")):
        await collect_github_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert mock_search.await_args.kwargs["user_id"] == "user-1"
    assert mock_get_repo.await_args.kwargs["user_id"] == "user-1"


@pytest.mark.asyncio
async def test_collect_github_trends_filters_old_repositories():
    session = AsyncMock()
    session.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=None))
    old_repo = GitHubRepo(
        full_name="owner/old",
        owner="owner",
        name="old",
        html_url="https://github.com/owner/old",
        stars=1000,
        forks=100,
        pushed_at=datetime.now(timezone.utc) - timedelta(days=500),
    )

    with patch("pkg.services.foundation.connector_trends.search_github_repos", new_callable=AsyncMock, return_value=[old_repo]), \
         patch("pkg.services.foundation.connector_trends.import_github_repo", new_callable=AsyncMock) as mock_import:
        items = await collect_github_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert items == []
    mock_import.assert_not_called()


@pytest.mark.asyncio
async def test_collect_daily_github_trends_skips_missing_user():
    session = AsyncMock()
    missing_user_rows = MagicMock()
    missing_user_rows.scalar_one_or_none.return_value = None
    session.execute.return_value = missing_user_rows

    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=None)

    with patch("pkg.services.foundation.connector_trends.async_session", return_value=session_cm), \
         patch("pkg.services.foundation.connector_trends.collect_github_trends_for_user", new_callable=AsyncMock) as mock_collect:
        stats = await collect_daily_github_trends(user_ids=["missing-user"])

    assert stats == {"users": 0, "github": 0, "failed": 1, "github_failed": 0, "skipped_missing_user": 1}
    mock_collect.assert_not_called()


@pytest.mark.asyncio
async def test_collect_daily_connector_trends_delegates_to_github_only_entry_point():
    expected = {"users": 1, "github": 2, "failed": 0, "github_failed": 0, "skipped_missing_user": 0}

    with patch(
        "pkg.services.foundation.connector_trends.collect_daily_github_trends",
        new_callable=AsyncMock,
        return_value=expected,
    ) as mock_collect:
        stats = await collect_daily_connector_trends(user_ids=["user-1"], trend_date="2026-09-15")

    assert stats == expected
    mock_collect.assert_awaited_once_with(user_ids=["user-1"], trend_date="2026-09-15")


def test_should_run_github_trend_profile_respects_schedule_and_last_run():
    now = datetime(2026, 9, 15, 8, tzinfo=timezone.utc)
    profile = GitHubTrendProfile(
        user_id="user-1",
        name="Agents",
        query="agent framework",
        schedule="manual",
        is_enabled=True,
        candidate_count=25,
        top_k=5,
    )

    assert not should_run_github_trend_profile(profile, now=now)
    profile.schedule = "daily"
    assert should_run_github_trend_profile(profile, now=now)
    profile.last_run_at = now - timedelta(hours=23)
    assert not should_run_github_trend_profile(profile, now=now)
    profile.last_run_at = now - timedelta(days=1)
    assert should_run_github_trend_profile(profile, now=now)
    profile.schedule = "weekly"
    assert not should_run_github_trend_profile(profile, now=now)
    profile.last_run_at = now - timedelta(days=7)
    assert should_run_github_trend_profile(profile, now=now)
    profile.is_enabled = False
    assert not should_run_github_trend_profile(profile, now=now)


@pytest.mark.asyncio
async def test_collect_github_trends_for_profile_uses_profile_scope():
    session = AsyncMock()
    profile = GitHubTrendProfile(
        user_id="user-1",
        name="Python Agents",
        query="agent framework",
        language="Python",
        schedule="weekly",
        is_enabled=True,
        candidate_count=40,
        top_k=8,
    )

    with patch(
        "pkg.services.foundation.connector_trends.collect_github_trends_for_user",
        new_callable=AsyncMock,
        return_value=[],
    ) as mock_collect:
        items = await collect_github_trends_for_profile(session, profile=profile, trend_date="2026-09-15")

    assert items == []
    assert profile.last_run_at is not None
    mock_collect.assert_awaited_once_with(
        session,
        user_id="user-1",
        trend_date="2026-09-15",
        query="agent framework",
        language="Python",
        candidate_count=40,
        top_k=8,
    )


@pytest.mark.asyncio
async def test_scheduled_github_profiles_isolate_profile_failures():
    session = AsyncMock()
    first = GitHubTrendProfile(
        id=1,
        user_id="user-1",
        name="Agents",
        query="agents",
        schedule="daily",
        is_enabled=True,
        candidate_count=25,
        top_k=5,
    )
    second = GitHubTrendProfile(
        id=2,
        user_id="user-2",
        name="Knowledge Graphs",
        query="knowledge graph",
        schedule="daily",
        is_enabled=True,
        candidate_count=25,
        top_k=5,
    )
    rows = MagicMock()
    rows.scalars.return_value = [first, second]
    session.execute.return_value = rows
    session.get.side_effect = [first, second]
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=None)

    with patch("pkg.services.foundation.connector_trends.async_session", return_value=session_cm), patch(
        "pkg.services.foundation.connector_trends.collect_github_trends_for_profile",
        new_callable=AsyncMock,
        side_effect=[[MagicMock(), MagicMock()], RuntimeError("provider failed")],
    ):
        stats = await run_scheduled_github_trend_profiles()

    assert stats == {
        "mode": "profiles",
        "profiles": 2,
        "eligible": 2,
        "runs": 1,
        "users": 0,
        "github": 2,
        "failed": 1,
        "reason": "partial_failure",
    }
    assert session.get.await_count == 2
    assert session.commit.await_count == 1
    assert session.rollback.await_count == 1


@pytest.mark.asyncio
async def test_scheduled_github_profiles_do_not_use_legacy_config_when_profiles_exist(monkeypatch):
    profile = GitHubTrendProfile(
        id=1,
        user_id="user-1",
        name="Manual",
        query="agents",
        schedule="manual",
        is_enabled=True,
        candidate_count=25,
        top_k=5,
    )
    session = AsyncMock()
    rows = MagicMock()
    rows.scalars.return_value = [profile]
    session.execute.return_value = rows
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "pkg.services.foundation.connector_trends.settings.CONNECTOR_TRENDS_USER_IDS",
        "legacy-user",
    )

    with patch("pkg.services.foundation.connector_trends.async_session", return_value=session_cm), patch(
        "pkg.services.foundation.connector_trends.collect_daily_github_trends",
        new_callable=AsyncMock,
    ) as mock_collect:
        stats = await run_scheduled_github_trend_profiles()

    assert stats["mode"] == "profiles"
    assert stats["profiles"] == 1
    assert stats["runs"] == 0
    assert stats["reason"] == "no_due_profiles"
    mock_collect.assert_not_awaited()


@pytest.mark.asyncio
async def test_scheduled_github_profiles_fall_back_to_configured_users(monkeypatch):
    session = AsyncMock()
    rows = MagicMock()
    rows.scalars.return_value = []
    session.execute.return_value = rows
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "pkg.services.foundation.connector_trends.settings.CONNECTOR_TRENDS_USER_IDS",
        "user-1, user-2, user-1",
    )
    legacy_stats = {
        "users": 2,
        "github": 3,
        "failed": 0,
        "github_failed": 0,
        "skipped_missing_user": 0,
    }

    with patch("pkg.services.foundation.connector_trends.async_session", return_value=session_cm), patch(
        "pkg.services.foundation.connector_trends.collect_daily_github_trends",
        new_callable=AsyncMock,
        return_value=legacy_stats,
    ) as mock_collect:
        stats = await run_scheduled_github_trend_profiles()

    assert stats == {
        "mode": "legacy_config",
        "profiles": 0,
        "eligible": 0,
        "runs": 2,
        "users": 2,
        "github": 3,
        "failed": 0,
        "reason": None,
    }
    mock_collect.assert_awaited_once_with(user_ids=["user-1", "user-2"])


@pytest.mark.asyncio
async def test_scheduled_github_profiles_report_missing_configuration(monkeypatch):
    session = AsyncMock()
    rows = MagicMock()
    rows.scalars.return_value = []
    session.execute.return_value = rows
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "pkg.services.foundation.connector_trends.settings.CONNECTOR_TRENDS_USER_IDS",
        "",
    )

    with patch("pkg.services.foundation.connector_trends.async_session", return_value=session_cm), patch(
        "pkg.services.foundation.connector_trends.collect_daily_github_trends",
        new_callable=AsyncMock,
    ) as mock_collect:
        stats = await run_scheduled_github_trend_profiles()

    assert stats["mode"] == "profiles"
    assert stats["profiles"] == 0
    assert stats["runs"] == 0
    assert stats["reason"] == "no_enabled_profiles_or_configured_users"
    mock_collect.assert_not_awaited()
