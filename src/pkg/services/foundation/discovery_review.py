from datetime import datetime, timezone

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def mark_discovery_item_saved(
    session: AsyncSession,
    *,
    user_id: str,
    provider: str,
    item_key: str,
    source_id: str,
) -> None:
    await session.execute(
        update(DiscoveryItem)
        .where(
            DiscoveryItem.user_id == user_id,
            DiscoveryItem.provider == provider,
            DiscoveryItem.item_key == item_key,
        )
        .values(
            status="saved",
            source_id=source_id,
            reviewed_at=_utc_now_naive(),
        )
    )


async def sync_discovery_review_for_source(
    session: AsyncSession,
    *,
    source: Source,
    status: str,
) -> int:
    metadata = dict(source.metadata_ or {})
    provider = str(metadata.get("connector") or "").strip().lower()
    item_key = None
    if provider == "github":
        item_key = str(metadata.get("repo_full_name") or "").strip()

    identity_filters = [DiscoveryItem.source_id == source.id]
    if provider and item_key:
        identity_filters.append(
            and_(DiscoveryItem.provider == provider, DiscoveryItem.item_key == item_key)
        )

    rows = await session.execute(
        select(DiscoveryItem).where(
            DiscoveryItem.user_id == source.user_id,
            or_(*identity_filters),
        )
    )
    items = list(rows.scalars())
    now = _utc_now_naive()
    for item in items:
        item.status = status
        item.reviewed_at = now
        item.feedback = {
            "action": "source_keep" if status == "saved" else "source_delete",
            "at": now.isoformat(),
        }
        item.source_id = source.id if status == "saved" else None
    return len(items)
