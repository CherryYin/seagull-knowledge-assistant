from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from pkg.config import settings
from pkg.db import async_session
from pkg.models.discovery import DiscoveryItem
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
