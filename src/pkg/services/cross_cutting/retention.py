from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from pkg.config import settings
from pkg.db import async_session
from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.wiki import WikiArticleDraft, WikiInsightCandidate, WikiMiningRun
from pkg.models.foundation.review import ReviewSuggestion


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def cleanup_discovery_items(retention_days: int = settings.DISCOVERY_RETENTION_DAYS) -> int:
    cutoff_dt = _utc_now_naive() - timedelta(days=max(retention_days, 0))
    async with async_session() as session:
        result = await session.execute(
            delete(DiscoveryItem).where(
                DiscoveryItem.status.in_(("dismissed", "kept", "saved")),
                DiscoveryItem.reviewed_at.is_not(None),
                DiscoveryItem.reviewed_at < cutoff_dt,
            )
        )
        await session.commit()
        return result.rowcount or 0


async def cleanup_review_suggestions(retention_days: int = settings.REVIEW_SUGGESTION_RETENTION_DAYS) -> int:
    cutoff_dt = _utc_now_naive() - timedelta(days=max(retention_days, 0))
    async with async_session() as session:
        result = await session.execute(
            delete(ReviewSuggestion).where(
                ReviewSuggestion.status.in_(("dismissed", "accepted", "rejected", "applied")),
                ReviewSuggestion.reviewed_at.is_not(None),
                ReviewSuggestion.reviewed_at < cutoff_dt,
            )
        )
        await session.commit()
        return result.rowcount or 0


async def cleanup_wiki_mining_runs(retention_days: int = 90) -> int:
    cutoff_dt = _utc_now_naive() - timedelta(days=max(retention_days, 0))
    async with async_session() as session:
        rows = await session.execute(
            select(WikiMiningRun.id)
            .where(WikiMiningRun.status == "completed")
            .where(WikiMiningRun.created_at < cutoff_dt)
        )
        run_ids = list(rows.scalars())
        deleted = 0
        for run_id in run_ids:
            unresolved_insight = await session.execute(
                select(WikiInsightCandidate.id)
                .where(WikiInsightCandidate.run_id == run_id)
                .where(WikiInsightCandidate.status.notin_(("accepted", "rejected", "converted_to_draft")))
                .limit(1)
            )
            if unresolved_insight.scalar_one_or_none() is not None:
                continue
            unresolved_article = await session.execute(
                select(WikiArticleDraft.id)
                .where(WikiArticleDraft.run_id == run_id)
                .where(WikiArticleDraft.status.notin_(("accepted", "rejected", "merged", "applied")))
                .limit(1)
            )
            if unresolved_article.scalar_one_or_none() is not None:
                continue
            run = await session.get(WikiMiningRun, run_id)
            if run:
                await session.delete(run)
                deleted += 1
        await session.commit()
        return deleted
