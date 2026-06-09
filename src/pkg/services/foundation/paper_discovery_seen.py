from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.paper_discovery_seen import PaperDiscoverySeenItem


async def get_seen_item(
    session: AsyncSession,
    *,
    user_id: str,
    profile_id: int,
    provider: str,
    item_key: str,
) -> PaperDiscoverySeenItem | None:
    row = await session.execute(
        select(PaperDiscoverySeenItem).where(
            PaperDiscoverySeenItem.user_id == user_id,
            PaperDiscoverySeenItem.profile_id == profile_id,
            PaperDiscoverySeenItem.provider == provider,
            PaperDiscoverySeenItem.item_key == item_key,
        )
    )
    return row.scalar_one_or_none()


async def mark_seen_item(
    session: AsyncSession,
    *,
    user_id: str,
    profile_id: int,
    provider: str,
    item_key: str,
    paper_provider_id: str | None,
    arxiv_id: str | None,
    doi: str | None,
    first_seen_run_id: int | None,
) -> PaperDiscoverySeenItem:
    existing = await get_seen_item(
        session,
        user_id=user_id,
        profile_id=profile_id,
        provider=provider,
        item_key=item_key,
    )
    if existing:
        return existing
    item = PaperDiscoverySeenItem(
        user_id=user_id,
        profile_id=profile_id,
        provider=provider,
        item_key=item_key,
        paper_provider_id=paper_provider_id,
        arxiv_id=arxiv_id,
        doi=doi,
        first_seen_run_id=first_seen_run_id,
    )
    session.add(item)
    return item
