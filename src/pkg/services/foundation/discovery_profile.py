from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.user import UserMemory
from pkg.services.cross_cutting.user_profiler import EXPLICIT_PREFERENCE_MEMORY_TYPE, PROFILE_MEMORY_KEY


DISCOVERY_PREFERENCES_MEMORY_KEY = "discovery_preferences"


async def load_discovery_profile(session: AsyncSession, user_id: str) -> dict:
    row = await session.execute(select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PROFILE_MEMORY_KEY))
    profile = row.scalar_one_or_none()
    return dict(profile.value or {}) if profile else {}


async def load_discovery_preferences(session: AsyncSession, user_id: str) -> dict:
    row = await session.execute(
        select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == DISCOVERY_PREFERENCES_MEMORY_KEY)
    )
    preference_memory = row.scalar_one_or_none()
    return dict(preference_memory.value or {}) if preference_memory and hasattr(preference_memory, "value") else {}


def candidate_preference_signals(candidate: dict) -> dict[str, list[str]]:
    payload = candidate.get("payload") or {}
    signals: dict[str, list[str]] = {"domains": [], "topics": [], "languages": [], "sources": []}
    domain = str(payload.get("domain") or _domain_from_url(str(payload.get("url") or payload.get("html_url") or payload.get("entry_url") or ""))).lower()
    if domain:
        signals["domains"].append(domain)
    for topic in payload.get("topics") or payload.get("categories") or []:
        if topic:
            signals["topics"].append(str(topic).strip().lower())
    language = payload.get("language")
    if language:
        signals["languages"].append(str(language).strip().lower())
    source_name = payload.get("source_name") or payload.get("connector") or candidate.get("source")
    if source_name:
        signals["sources"].append(str(source_name).strip().lower())
    return {key: list(dict.fromkeys([value for value in values if value])) for key, values in signals.items()}


async def update_profile_feedback(
    session: AsyncSession,
    *,
    user_id: str,
    provider: str,
    action: str,
    item: DiscoveryItem | None = None,
) -> None:
    try:
        preference_row = await session.execute(
            select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == DISCOVERY_PREFERENCES_MEMORY_KEY)
        )
        preference_memory = preference_row.scalar_one_or_none()
        if preference_memory is not None and not hasattr(preference_memory, "value"):
            preference_memory = None
    except (StopAsyncIteration, StopIteration):
        preference_memory = None

    profile_row = await session.execute(
        select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PROFILE_MEMORY_KEY)
    )
    profile_memory = profile_row.scalar_one_or_none()
    if preference_memory:
        value = dict(preference_memory.value or {})
    else:
        value = {}
        if profile_memory and hasattr(profile_memory, "value"):
            value = {
                "discovery_feedback": dict((profile_memory.value or {}).get("discovery_feedback") or {}),
                "discovery_preferences": dict((profile_memory.value or {}).get("discovery_preferences") or {}),
            }

    feedback = dict(value.get("discovery_feedback") or {})
    provider_feedback = dict(feedback.get(provider) or {})
    provider_feedback[action] = int(provider_feedback.get(action) or 0) + 1
    feedback[provider] = provider_feedback
    value["discovery_feedback"] = feedback

    if item is not None:
        preferences = dict(value.get("discovery_preferences") or {})
        for group, values in candidate_preference_signals({"provider": item.provider, "payload": item.payload or {}}).items():
            group_prefs = dict(preferences.get(group) or {})
            for signal in values[:12]:
                stats = dict(group_prefs.get(signal) or {})
                stats[action] = int(stats.get(action) or 0) + 1
                group_prefs[signal] = stats
            preferences[group] = group_prefs
        value["discovery_preferences"] = preferences

    if preference_memory:
        preference_memory.memory_type = EXPLICIT_PREFERENCE_MEMORY_TYPE
        preference_memory.value = value
    else:
        session.add(
            UserMemory(
                user_id=user_id,
                key=DISCOVERY_PREFERENCES_MEMORY_KEY,
                memory_type=EXPLICIT_PREFERENCE_MEMORY_TYPE,
                value=value,
            )
        )


def _domain_from_url(url: str) -> str:
    from urllib.parse import urlparse

    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower().split("@")[ -1].split(":")[0]
    return host[4:] if host.startswith("www.") else host
