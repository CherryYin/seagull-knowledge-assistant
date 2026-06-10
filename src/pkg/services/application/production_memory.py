from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.user import UserMemory

PRODUCTION_MEMORY_KEY = "production_memory"
PRODUCTION_MEMORY_TYPE = "production_memory"
MAX_PRODUCTION_EVENTS = 200


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


async def record_asset_production_event(
    session: AsyncSession,
    *,
    user_id: str,
    asset: Asset,
    event_type: str,
    detail: dict | None = None,
) -> UserMemory:
    row = await session.execute(select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PRODUCTION_MEMORY_KEY))
    memory = row.scalar_one_or_none()
    value = dict(memory.value or {}) if memory else {}
    events = list(value.get("events") or [])
    event = {
        "event_type": event_type,
        "asset_id": asset.id,
        "asset_type": asset.asset_type,
        "title": asset.title,
        "status": asset.status,
        "timestamp": _utc_now_iso(),
        "detail": detail or {},
    }
    events.insert(0, event)
    value["events"] = events[:MAX_PRODUCTION_EVENTS]
    value["last_event"] = event
    if memory:
        memory.memory_type = PRODUCTION_MEMORY_TYPE
        memory.value = value
    else:
        memory = UserMemory(
            user_id=user_id,
            key=PRODUCTION_MEMORY_KEY,
            memory_type=PRODUCTION_MEMORY_TYPE,
            value=value,
        )
        session.add(memory)
    await session.flush()
    return memory
