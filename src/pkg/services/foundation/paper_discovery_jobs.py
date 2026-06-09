from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.paper_discovery import PaperDiscoveryProfile
from pkg.services.foundation.paper_discovery import execute_profile_run


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def should_run_profile(profile: PaperDiscoveryProfile, *, now: datetime | None = None) -> bool:
    now = now or _utc_now()
    if not profile.is_enabled:
        return False
    if profile.schedule == "manual":
        return False
    if profile.last_run_at is None:
        return True
    last_run_at = profile.last_run_at
    if last_run_at.tzinfo is None:
        last_run_at = last_run_at.replace(tzinfo=timezone.utc)
    if profile.schedule == "daily":
        return now - last_run_at >= timedelta(days=1)
    if profile.schedule == "weekly":
        return now - last_run_at >= timedelta(days=7)
    return False


async def run_scheduled_paper_discovery_profiles(session: AsyncSession) -> dict[str, int]:
    rows = await session.execute(
        select(PaperDiscoveryProfile).where(PaperDiscoveryProfile.is_enabled.is_(True))
    )
    profiles = list(rows.scalars())
    stats = {"profiles": len(profiles), "eligible": 0, "runs": 0, "created": 0, "updated": 0}
    for profile in profiles:
        if not should_run_profile(profile):
            continue
        stats["eligible"] += 1
        _run, _items, created, updated = await execute_profile_run(
            session,
            user_id=profile.user_id,
            profile_id=profile.id,
            mode="query",
            commit=False,
        )
        stats["runs"] += 1
        stats["created"] += created
        stats["updated"] += updated
    await session.commit()
    return stats
