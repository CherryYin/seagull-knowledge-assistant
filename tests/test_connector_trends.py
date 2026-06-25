from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from pkg.schemas.connector import ArxivPaper, GitHubRepo
from pkg.services.foundation.connector_trends import (
    score_arxiv_paper,
    score_github_repo,
    collect_arxiv_trends_for_user,
    collect_daily_connector_trends,
    collect_github_trends_for_user,
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
async def test_collect_daily_connector_trends_skips_missing_user():
    session = AsyncMock()
    missing_user_rows = MagicMock()
    missing_user_rows.scalar_one_or_none.return_value = None
    session.execute.return_value = missing_user_rows

    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=None)

    with patch("pkg.services.foundation.connector_trends.async_session", return_value=session_cm), \
         patch("pkg.services.foundation.connector_trends.collect_github_trends_for_user", new_callable=AsyncMock) as mock_collect:
        stats = await collect_daily_connector_trends(user_ids=["missing-user"])

    assert stats == {"users": 0, "github": 0, "failed": 1, "github_failed": 0, "skipped_missing_user": 1}
    mock_collect.assert_not_called()
