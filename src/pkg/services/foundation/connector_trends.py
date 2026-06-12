import math
import logging
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.connector_trend import ConnectorTrendItem
from pkg.models.user import User
from pkg.schemas.connector import ArxivPaper, GitHubRepo
from pkg.services.foundation.connectors import (
    ArxivRateLimitError,
    canonical_arxiv_id,
    get_github_repo,
    import_arxiv_paper,
    import_github_repo,
    one_year_ago_date,
    search_arxiv,
    search_github_repos,
)

SEMANTIC_SCHOLAR_API_URL = "https://api.semanticscholar.org/graph/v1/paper"
logger = logging.getLogger(__name__)


def today_key() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _is_within_last_year(value: datetime | None, *, reference: datetime | None = None) -> bool:
    if value is None:
        return False
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    reference = reference or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return value >= reference - timedelta(days=365)


def _age_days(value: datetime | None) -> int:
    if value is None:
        return 3650
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(timezone.utc) - value).days)


def score_arxiv_paper(paper: ArxivPaper, citation_count: int = 0) -> float:
    """Score papers by citations and recency.

    Citation signal is log-scaled so very old famous papers do not dominate.
    Recency half-life is roughly 180 days.
    """
    citation_signal = math.log1p(max(citation_count, 0)) * 12
    recency_signal = 40 * math.exp(-_age_days(paper.published or paper.updated) / 180)
    return citation_signal + recency_signal


def score_github_repo(repo: GitHubRepo, previous_stars: int | None = None, previous_forks: int | None = None) -> float:
    star_growth = max(0, repo.stars - previous_stars) if previous_stars is not None else 0
    fork_growth = max(0, repo.forks - previous_forks) if previous_forks is not None else 0
    if previous_stars is None and previous_forks is None:
        return math.log1p(repo.stars) * 2 + math.log1p(repo.forks)
    return star_growth * 1.0 + fork_growth * 2.0


async def fetch_arxiv_citation_count(arxiv_id: str) -> int:
    paper_id = f"arXiv:{canonical_arxiv_id(arxiv_id)}"
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(f"{SEMANTIC_SCHOLAR_API_URL}/{paper_id}", params={"fields": "citationCount"})
        if response.status_code == 404:
            return 0
        response.raise_for_status()
    return int((response.json() or {}).get("citationCount") or 0)


async def _previous_github_metrics(session: AsyncSession, *, user_id: str, full_name: str, trend_date: str) -> tuple[int | None, int | None]:
    since = (datetime.fromisoformat(trend_date) - timedelta(days=8)).date().isoformat()
    rows = await session.execute(
        select(ConnectorTrendItem)
        .where(
            ConnectorTrendItem.user_id == user_id,
            ConnectorTrendItem.provider == "github",
            ConnectorTrendItem.item_key == full_name.lower(),
            ConnectorTrendItem.trend_date >= since,
            ConnectorTrendItem.trend_date < trend_date,
        )
        .order_by(ConnectorTrendItem.trend_date.asc())
        .limit(1)
    )
    item = rows.scalar_one_or_none()
    if not item or not item.metadata_:
        return None, None
    return item.metadata_.get("stars"), item.metadata_.get("forks")


async def upsert_trend_item(
    session: AsyncSession,
    *,
    user_id: str,
    provider: str,
    trend_date: str,
    item_key: str,
    title: str,
    rank: int,
    score: float,
    source_id: str | None,
    metadata: dict,
) -> ConnectorTrendItem:
    rows = await session.execute(
        select(ConnectorTrendItem).where(
            ConnectorTrendItem.user_id == user_id,
            ConnectorTrendItem.provider == provider,
            ConnectorTrendItem.trend_date == trend_date,
            ConnectorTrendItem.item_key == item_key,
        )
    )
    item = rows.scalar_one_or_none()
    if item:
        item.title = title
        item.rank = rank
        item.score = score
        item.source_id = source_id
        item.metadata_ = metadata
        return item
    item = ConnectorTrendItem(
        user_id=user_id,
        provider=provider,
        trend_date=trend_date,
        item_key=item_key,
        title=title,
        rank=rank,
        score=score,
        source_id=source_id,
        metadata_=metadata,
    )
    session.add(item)
    return item


async def collect_arxiv_trends_for_user(
    session: AsyncSession,
    *,
    user_id: str,
    trend_date: str | None = None,
    query: str | None = None,
    category: str | None = None,
    candidate_count: int = 25,
    top_k: int = 5,
) -> list[ConnectorTrendItem]:
    trend_date = trend_date or today_key()
    try:
        papers = await search_arxiv(
            query=query or settings.CONNECTOR_TRENDS_ARXIV_QUERY,
            category=category or settings.CONNECTOR_TRENDS_ARXIV_CATEGORY or None,
            date_from=one_year_ago_date(),
            max_results=candidate_count,
        )
    except ArxivRateLimitError:
        logger.warning("arXiv trend collection rate-limited for user %s; skipping arXiv for this run", user_id)
        return []
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            logger.warning("arXiv trend collection rate-limited for user %s; skipping arXiv for this run", user_id)
            return []
        raise
    except httpx.TimeoutException as exc:
        logger.warning(
            "arXiv trend collection timed out for user %s; skipping arXiv for this run: %s",
            user_id,
            exc,
        )
        return []
    except httpx.NetworkError as exc:
        logger.warning(
            "arXiv trend collection network error for user %s; skipping arXiv for this run: %s",
            user_id,
            exc,
        )
        return []
    papers = [paper for paper in papers if _is_within_last_year(paper.published or paper.updated)]
    scored: list[tuple[ArxivPaper, int, float]] = []
    for paper in papers:
        try:
            citations = await fetch_arxiv_citation_count(paper.arxiv_id)
        except Exception:
            citations = 0
        scored.append((paper, citations, score_arxiv_paper(paper, citations)))
    scored.sort(key=lambda item: item[2], reverse=True)

    results: list[ConnectorTrendItem] = []
    for rank, (paper, citations, score) in enumerate(scored[:top_k], start=1):
        source, _created, _dedupe = await import_arxiv_paper(session, user_id=user_id, paper=paper)
        results.append(await upsert_trend_item(
            session,
            user_id=user_id,
            provider="arxiv",
            trend_date=trend_date,
            item_key=canonical_arxiv_id(paper.arxiv_id),
            title=paper.title,
            rank=rank,
            score=score,
            source_id=source.id,
            metadata={
                "citation_count": citations,
                "published": paper.published.isoformat() if paper.published else None,
                "updated": paper.updated.isoformat() if paper.updated else None,
                "categories": paper.categories,
                "entry_url": paper.entry_url,
                "pdf_url": paper.pdf_url,
            },
        ))
    return results


async def collect_github_trends_for_user(
    session: AsyncSession,
    *,
    user_id: str,
    trend_date: str | None = None,
    query: str | None = None,
    language: str | None = None,
    candidate_count: int = 25,
    top_k: int = 5,
) -> list[ConnectorTrendItem]:
    trend_date = trend_date or today_key()
    repos = await search_github_repos(
        query=query or settings.CONNECTOR_TRENDS_GITHUB_QUERY,
        language=language or settings.CONNECTOR_TRENDS_GITHUB_LANGUAGE or None,
        pushed_after=one_year_ago_date(),
        max_results=candidate_count,
    )
    repos = [repo for repo in repos if _is_within_last_year(repo.pushed_at)]
    scored: list[tuple[GitHubRepo, int | None, int | None, float]] = []
    for repo in repos:
        previous_stars, previous_forks = await _previous_github_metrics(session, user_id=user_id, full_name=repo.full_name, trend_date=trend_date)
        scored.append((repo, previous_stars, previous_forks, score_github_repo(repo, previous_stars, previous_forks)))
    scored.sort(key=lambda item: item[3], reverse=True)

    results: list[ConnectorTrendItem] = []
    for rank, (repo, previous_stars, previous_forks, score) in enumerate(scored[:top_k], start=1):
        repo_for_import = await get_github_repo(repo.full_name, fetch_readme=True)
        source, _created, _dedupe = await import_github_repo(session, user_id=user_id, repo=repo_for_import)
        results.append(await upsert_trend_item(
            session,
            user_id=user_id,
            provider="github",
            trend_date=trend_date,
            item_key=repo.full_name.lower(),
            title=repo.full_name,
            rank=rank,
            score=score,
            source_id=source.id,
            metadata={
                "stars": repo_for_import.stars,
                "forks": repo_for_import.forks,
                "previous_stars": previous_stars,
                "previous_forks": previous_forks,
                "star_growth_7d": max(0, repo_for_import.stars - previous_stars) if previous_stars is not None else None,
                "fork_growth_7d": max(0, repo_for_import.forks - previous_forks) if previous_forks is not None else None,
                "language": repo_for_import.language,
                "topics": repo_for_import.topics,
                "html_url": repo_for_import.html_url,
            },
        ))
    return results


async def _trend_user_ids(session: AsyncSession, explicit_user_ids: list[str] | None = None) -> list[str]:
    if explicit_user_ids:
        return explicit_user_ids
    configured = [item.strip() for item in settings.CONNECTOR_TRENDS_USER_IDS.split(",") if item.strip()]
    if configured:
        return configured
    rows = await session.execute(select(User.id).where(User.is_active.is_(True)))
    return list(rows.scalars())


async def _active_user_exists(session: AsyncSession, user_id: str) -> bool:
    row = await session.execute(
        select(User.id).where(User.id == user_id, User.is_active.is_(True)).limit(1)
    )
    return row.scalar_one_or_none() is not None


async def collect_daily_connector_trends(*, user_ids: list[str] | None = None, trend_date: str | None = None) -> dict[str, int]:
    stats = {"users": 0, "github": 0, "failed": 0, "github_failed": 0, "skipped_missing_user": 0}
    async with async_session() as session:
        target_users = await _trend_user_ids(session, user_ids)
        for user_id in target_users:
            if not await _active_user_exists(session, user_id):
                stats["failed"] += 1
                stats["skipped_missing_user"] += 1
                logger.warning(
                    "Skipping connector trend collection for unknown or inactive user %s. "
                    "Check CONNECTOR_TRENDS_USER_IDS or the users table.",
                    user_id,
                )
                continue
            user_ok = False
            try:
                github_items = await collect_github_trends_for_user(session, user_id=user_id, trend_date=trend_date)
                stats["github"] += len(github_items)
                user_ok = True
                await session.commit()
            except Exception:
                stats["github_failed"] += 1
                stats["failed"] += 1
                await session.rollback()
                logger.exception("GitHub trend collection failed for user %s", user_id)
            if user_ok:
                stats["users"] += 1
    return stats
