from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.connector_cache import ConnectorSearchItem

CACHE_TTL_DAYS = 7


def connector_cache_key(provider: str, item: BaseModel | dict[str, Any]) -> str:
    data = item.model_dump(mode="json") if isinstance(item, BaseModel) else item
    if provider == "arxiv":
        return str(data.get("arxiv_id") or data.get("entry_url") or data.get("title"))
    if provider == "github":
        return str(data.get("full_name") or data.get("html_url") or data.get("name"))
    if provider == "news":
        url = str(data.get("url") or "").strip()
        if url:
            return url
        return str(data.get("title") or data.get("source_name") or "news")
    return str(data.get("id") or data.get("key") or data.get("title"))


def connector_cache_title(provider: str, item: BaseModel | dict[str, Any]) -> str:
    data = item.model_dump(mode="json") if isinstance(item, BaseModel) else item
    if provider == "github":
        return str(data.get("full_name") or data.get("name") or connector_cache_key(provider, data))
    return str(data.get("title") or connector_cache_key(provider, data))


async def upsert_connector_search_items(
    session: AsyncSession,
    *,
    user_id: str,
    provider: str,
    items: list[BaseModel],
) -> dict[str, ConnectorSearchItem]:
    now = datetime.now(timezone.utc)
    await delete_expired_connector_search_items(session, user_id=user_id, provider=provider, now=now)
    expires_at = now + timedelta(days=CACHE_TTL_DAYS)
    keys = [connector_cache_key(provider, item) for item in items]
    existing: dict[str, ConnectorSearchItem] = {}
    if keys:
        rows = await session.execute(
            select(ConnectorSearchItem).where(
                ConnectorSearchItem.user_id == user_id,
                ConnectorSearchItem.provider == provider,
                ConnectorSearchItem.item_key.in_(keys),
            )
        )
        existing = {row.item_key: row for row in rows.scalars()}

    result: dict[str, ConnectorSearchItem] = {}
    for item in items:
        key = connector_cache_key(provider, item)
        payload = item.model_dump(mode="json")
        cached = existing.get(key)
        if cached:
            cached.title = connector_cache_title(provider, item)
            cached.payload = payload
            if cached.status != "saved":
                cached.status = "cached"
                cached.expires_at = expires_at
            result[key] = cached
            continue
        cached = ConnectorSearchItem(
            user_id=user_id,
            provider=provider,
            item_key=key,
            title=connector_cache_title(provider, item),
            status="cached",
            payload=payload,
            expires_at=expires_at,
        )
        session.add(cached)
        result[key] = cached
    await session.flush()
    return result


async def mark_connector_item_saved(
    session: AsyncSession,
    *,
    user_id: str,
    provider: str,
    item_key: str,
    source_id: str,
) -> ConnectorSearchItem | None:
    row = await session.execute(
        select(ConnectorSearchItem).where(
            ConnectorSearchItem.user_id == user_id,
            ConnectorSearchItem.provider == provider,
            ConnectorSearchItem.item_key == item_key,
        )
    )
    cached = row.scalar_one_or_none()
    if not cached:
        return None
    cached.status = "saved"
    cached.source_id = source_id
    cached.saved_at = datetime.now(timezone.utc)
    cached.expires_at = None
    return cached


async def delete_expired_connector_search_items(
    session: AsyncSession,
    *,
    user_id: str | None = None,
    provider: str | None = None,
    now: datetime | None = None,
) -> int:
    now = now or datetime.now(timezone.utc)
    filters = [
        ConnectorSearchItem.status != "saved",
        ConnectorSearchItem.expires_at.is_not(None),
        ConnectorSearchItem.expires_at < now,
    ]
    if user_id:
        filters.append(ConnectorSearchItem.user_id == user_id)
    if provider:
        filters.append(ConnectorSearchItem.provider == provider)
    result = await session.execute(delete(ConnectorSearchItem).where(*filters))
    return result.rowcount or 0


async def cleanup_expired_connector_cache(session: AsyncSession, *, now: datetime | None = None) -> int:
    deleted = await delete_expired_connector_search_items(session, now=now)
    await session.commit()
    return deleted
