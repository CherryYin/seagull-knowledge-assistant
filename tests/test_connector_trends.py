from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.schemas.connector import ArxivPaper, GitHubRepo
from pkg.services.connector_trends import score_arxiv_paper, score_github_repo, collect_arxiv_trends_for_user, collect_github_trends_for_user


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

    with patch("pkg.services.connector_trends.search_arxiv", new_callable=AsyncMock, return_value=[paper_b, paper_a]) as mock_search, \
         patch("pkg.services.connector_trends.fetch_arxiv_citation_count", new_callable=AsyncMock, side_effect=[50]), \
         patch("pkg.services.connector_trends.import_arxiv_paper", new_callable=AsyncMock, return_value=(source, True, "arxiv:2401.1")):
        items = await collect_arxiv_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert mock_search.await_args.kwargs["date_from"]

    assert len(items) == 1
    assert items[0].provider == "arxiv"
    assert items[0].rank == 1
    assert items[0].metadata_["citation_count"] == 50


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

    with patch("pkg.services.connector_trends.search_github_repos", new_callable=AsyncMock, return_value=[repo]) as mock_search, \
         patch("pkg.services.connector_trends.get_github_repo", new_callable=AsyncMock, return_value=repo), \
         patch("pkg.services.connector_trends.import_github_repo", new_callable=AsyncMock, return_value=(source, True, "github:owner/repo")):
        items = await collect_github_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert mock_search.await_args.kwargs["pushed_after"]

    assert len(items) == 1
    assert items[0].provider == "github"
    assert items[0].metadata_["star_growth_7d"] == 30
    assert items[0].metadata_["fork_growth_7d"] == 5


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

    with patch("pkg.services.connector_trends.search_github_repos", new_callable=AsyncMock, return_value=[old_repo]), \
         patch("pkg.services.connector_trends.import_github_repo", new_callable=AsyncMock) as mock_import:
        items = await collect_github_trends_for_user(session, user_id="user-1", trend_date="2026-05-22", top_k=1)

    assert items == []
    mock_import.assert_not_called()
