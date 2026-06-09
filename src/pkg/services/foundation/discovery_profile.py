from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.user import UserMemory
from pkg.services.cross_cutting.user_profiler import PROFILE_MEMORY_KEY


async def load_discovery_profile(session: AsyncSession, user_id: str) -> dict:
    row = await session.execute(select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PROFILE_MEMORY_KEY))
    profile = row.scalar_one_or_none()
    return dict(profile.value or {}) if profile else {}


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
    row = await session.execute(select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PROFILE_MEMORY_KEY))
    profile = row.scalar_one_or_none()
    if not profile:
        return
    value = dict(profile.value or {})
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

    profile.value = value


def _domain_from_url(url: str) -> str:
    from urllib.parse import urlparse

    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower().split("@")[ -1].split(":")[0]
    return host[4:] if host.startswith("www.") else host
