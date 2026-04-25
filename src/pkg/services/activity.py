"""Lightweight activity logging helper.

Usage:
    await log_activity(user.id, "search", {"query": "knowledge graph"})
"""
from pkg.db import async_session
from pkg.models.user import ActivityLog


async def log_activity(user_id: str, action: str, detail: dict | None = None) -> None:
    """Record a user activity. Failures are silently ignored (non-critical)."""
    try:
        async with async_session() as session:
            session.add(ActivityLog(user_id=user_id, action=action, detail=detail))
            await session.commit()
    except Exception:
        pass  # Activity logging should never break the main flow
