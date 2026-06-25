from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.user import UserSettings


async def get_user_settings_dict(session: AsyncSession, user_id: str) -> dict:
    obj = await session.get(UserSettings, user_id)
    if not obj or not isinstance(obj.settings, dict):
        return {}
    return obj.settings


async def get_user_setting_str(session: AsyncSession, user_id: str, key: str, default: str = "") -> str:
    settings = await get_user_settings_dict(session, user_id)
    value = settings.get(key, default)
    if value is None:
        return default
    return str(value).strip()
