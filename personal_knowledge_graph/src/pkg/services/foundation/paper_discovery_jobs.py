import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.paper_discovery import PaperDiscoveryProfile
from pkg.services.foundation.paper_discovery import execute_profile_run


logger = logging.getLogger(__name__)


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
    due_profiles = [
        (profile.user_id, profile.id)
        for profile in profiles
        if should_run_profile(profile)
    ]
    stats = {
        "profiles": len(profiles),
        "eligible": len(due_profiles),
        "runs": 0,
        "created": 0,
        "updated": 0,
        "errors": 0,
    }
    for user_id, profile_id in due_profiles:
        try:
            _run, _items, created, updated = await execute_profile_run(
                session,
                user_id=user_id,
                profile_id=profile_id,
                mode="query",
                commit=False,
            )
            await session.commit()
        except Exception:
            await session.rollback()
            stats["errors"] += 1
            logger.exception("Scheduled paper discovery failed for profile %s", profile_id)
            continue
        stats["runs"] += 1
        stats["created"] += created
        stats["updated"] += updated
    return stats
