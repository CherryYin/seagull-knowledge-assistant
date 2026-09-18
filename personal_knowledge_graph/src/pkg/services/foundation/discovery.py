import asyncio
import hashlib
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.connector_cache import ConnectorSearchItem
from pkg.models.connector_trend import ConnectorTrendItem
from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source
from pkg.services.cross_cutting.user_api_credentials import get_default_user_api_credential_secret
from pkg.services.foundation.connectors import import_github_repo
from pkg.services.foundation.connector_cache import connector_cache_key
from pkg.services.foundation.discovery_imports import domain_from_url, import_discovery_item, normalize_http_url
from pkg.services.foundation.discovery_profile import load_discovery_preferences, load_discovery_profile
from pkg.services.foundation.discovery_scoring import candidate_summary, candidate_url, score_candidate


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


DEFAULT_DISCOVERY_PROVIDERS = ["arxiv", "github", "news"]


async def refresh_discovery_recommendations(
    session: AsyncSession,
    *,
    user_id: str,
    providers: list[str] | None = None,
    limit: int = 50,
    commit: bool = True,
) -> tuple[int, int, int]:
    providers = providers or DEFAULT_DISCOVERY_PROVIDERS
    profile = await load_discovery_profile(session, user_id)
    try:
        preferences = await load_discovery_preferences(session, user_id)
    except (StopAsyncIteration, StopIteration):
        preferences = {}
    if preferences:
        profile = {**profile, **preferences}
    created = 0
    updated = 0
    skipped = 0
    recommended_count = await _recommended_discovery_count(session, user_id=user_id)
    recommended_capacity = max(settings.DISCOVERY_MAX_RECOMMENDED_PER_USER - recommended_count, 0)
    candidates = await _load_candidates(session, user_id=user_id, providers=providers, limit=limit)
    for candidate in candidates[:limit]:
        item, was_created = await _upsert_discovery_item(
            session,
            user_id=user_id,
            candidate=candidate,
            profile=profile,
            allow_recommended_create=recommended_capacity > 0,
        )
        if item is None:
            skipped += 1
            continue
        if item.status in {"kept", "saved", "dismissed"}:
            skipped += 1
        elif was_created:
            created += 1
            recommended_capacity -= 1
        else:
            updated += 1
    if commit:
        await session.commit()
    return created, updated, skipped


async def generate_discovery_items(
    session: AsyncSession,
    *,
    user_id: str,
    providers: list[str] | None = None,
    limit: int = 50,
    commit: bool = True,
) -> tuple[int, int, int]:
    return await refresh_discovery_recommendations(
        session,
        user_id=user_id,
        providers=providers,
        limit=limit,
        commit=commit,
    )


async def apply_discovery_feedback(
    session: AsyncSession,
    *,
    item: DiscoveryItem,
    action: str,
    note: str | None = None,
) -> tuple[object | None, bool | None]:
    from pkg.services.foundation.discovery_profile import update_profile_feedback

    now = _utc_now_naive()
    item.feedback = {"action": action, "note": note, "at": now.isoformat()}
    item.reviewed_at = now
    source = None
    created = None

    if action == "keep":
        if item.source_id:
            source = await session.get(Source, item.source_id)
            created = False
        item.status = "kept"
    elif action == "save":
        if item.source_id:
            source = await session.get(Source, item.source_id)
            created = False
        else:
            source, created, _dedupe = await import_discovery_item(session, item)
        item.status = "saved"
        if source:
            item.source_id = source.id
    elif action == "dismiss":
        item.status = "dismissed"

    await update_profile_feedback(session, user_id=item.user_id, provider=item.provider, action=action, item=item)
    await session.commit()
    await session.refresh(item)
    return source, created


async def search_external_web_results(query: str, *, max_results: int = 10, user_id: str | None = None) -> list[dict]:
    resolved_api_key = settings.TAVILY_API_KEY
    if user_id:
        async with async_session() as session:
            user_secret, _user_config = await get_default_user_api_credential_secret(session, user_id=user_id, provider="tavily")
        if user_secret:
            resolved_api_key = user_secret
    if not resolved_api_key:
        raise ValueError("TAVILY_API_KEY is not configured")
    from tavily import TavilyClient

    client = TavilyClient(api_key=resolved_api_key)
    response = await asyncio.wait_for(
        asyncio.to_thread(
            client.search,
            query=query,
            max_results=min(max(max_results, 1), 20),
            include_answer=False,
        ),
        timeout=20,
    )
    results = response.get("results") or []
    items: list[dict] = []
    for result in results:
        url = str(result.get("url") or "").strip()
        title = str(result.get("title") or url).strip()
        url = normalize_http_url(url)
        if not url or not title:
            continue
        items.append({
            "title": title,
            "url": url,
            "summary": result.get("content"),
            "source_name": "tavily",
            "published_at": result.get("published_date"),
        })
    return items


async def ingest_web_discovery_results(
    session: AsyncSession,
    *,
    user_id: str,
    query: str,
    items: list[dict],
    commit: bool = True,
) -> tuple[int, int, int]:
    profile = await load_discovery_profile(session, user_id)
    try:
        preferences = await load_discovery_preferences(session, user_id)
    except (StopAsyncIteration, StopIteration):
        preferences = {}
    if preferences:
        profile = {**profile, **preferences}
    created = 0
    updated = 0
    skipped = 0
    recommended_count = await _recommended_discovery_count(session, user_id=user_id)
    recommended_capacity = max(settings.DISCOVERY_MAX_RECOMMENDED_PER_USER - recommended_count, 0)
    for raw_item in items:
        url = normalize_http_url(str(raw_item.get("url") or "").strip())
        title = str(raw_item.get("title") or url or "").strip()
        if not url or not title:
            skipped += 1
            continue
        payload = {
            "title": title,
            "url": url,
            "summary": raw_item.get("summary"),
            "source_name": raw_item.get("source_name"),
            "published_at": raw_item.get("published_at"),
            "query": query,
            "domain": domain_from_url(url),
            "discovery_source": "external_web_search",
        }
        candidate = {
            "source": "external_web_search",
            "provider": "web",
            "item_key": _web_item_key(url),
            "title": title,
            "payload": payload,
            "base_score": 12,
            "source_id": None,
        }
        item, was_created = await _upsert_discovery_item(
            session,
            user_id=user_id,
            candidate=candidate,
            profile=profile,
            allow_recommended_create=recommended_capacity > 0,
        )
        if item is None:
            skipped += 1
            continue
        if item.status in {"kept", "saved", "dismissed"}:
            skipped += 1
        elif was_created:
            created += 1
            recommended_capacity -= 1
        else:
            updated += 1
    if commit:
        await session.commit()
    return created, updated, skipped


async def _load_candidates(session: AsyncSession, *, user_id: str, providers: list[str], limit: int) -> list[dict]:
    candidates: list[dict] = []
    cache_payloads = await _load_cache_payloads(session, user_id=user_id, providers=providers)
    connector_providers = [
        provider
        for provider in providers
        if provider in {"arxiv", "github", "news"}
    ]

    if connector_providers:
        rows = await session.execute(
            select(ConnectorSearchItem)
            .where(ConnectorSearchItem.user_id == user_id)
            .where(ConnectorSearchItem.provider.in_(connector_providers))
            .where(ConnectorSearchItem.status == "cached")
            .where(ConnectorSearchItem.source_id.is_(None))
            .order_by(ConnectorSearchItem.updated_at.desc())
            .limit(limit * 3)
        )
        for item in rows.scalars():
            if item.source_id or item.status not in {None, "cached"}:
                continue
            payload = cache_payloads.get((item.provider, item.item_key), item.payload)
            candidates.append({
                "source": "connector_cache",
                "provider": item.provider,
                "item_key": item.item_key,
                "title": item.title,
                "payload": payload,
                "base_score": 0,
                "source_id": None,
            })

    else:
        await session.execute(
            select(ConnectorSearchItem)
            .where(ConnectorSearchItem.user_id == user_id)
            .where(ConnectorSearchItem.provider.in_([]))
        )

    trend_providers = [provider for provider in providers if provider in {"github", "arxiv"}]
    if trend_providers:
        trend_rows = await session.execute(
            select(ConnectorTrendItem)
            .where(ConnectorTrendItem.user_id == user_id)
            .where(ConnectorTrendItem.provider.in_(trend_providers))
            .where(ConnectorTrendItem.source_id.is_(None))
            .order_by(ConnectorTrendItem.updated_at.desc())
            .limit(limit * 2)
        )
        for trend in trend_rows.scalars():
            if trend.source_id:
                continue
            payload = cache_payloads.get((trend.provider, trend.item_key), trend.metadata_)
            candidates.append({
                "source": "trend",
                "provider": trend.provider,
                "item_key": trend.item_key,
                "title": trend.title,
                "payload": payload,
                "base_score": 6,
                "source_id": None,
            })

    else:
        await session.execute(
            select(ConnectorTrendItem)
            .where(ConnectorTrendItem.user_id == user_id)
            .where(ConnectorTrendItem.provider.in_([]))
        )

    return _dedupe_candidates(candidates)


async def _load_cache_payloads(session: AsyncSession, *, user_id: str, providers: list[str]) -> dict[tuple[str, str], dict]:
    rows = await session.execute(
        select(ConnectorSearchItem)
        .where(ConnectorSearchItem.user_id == user_id)
        .where(ConnectorSearchItem.provider.in_(providers))
    )
    return {(item.provider, item.item_key): item.payload for item in rows.scalars()}


async def _recommended_discovery_count(session: AsyncSession, *, user_id: str) -> int:
    rows = await session.execute(
        select(func.count()).select_from(DiscoveryItem).where(
            DiscoveryItem.user_id == user_id,
            DiscoveryItem.status == "recommended",
        )
    )
    return int(rows.scalar_one_or_none() or 0)


async def _upsert_discovery_item(
    session: AsyncSession,
    *,
    user_id: str,
    candidate: dict,
    profile: dict,
    allow_recommended_create: bool = True,
) -> tuple[DiscoveryItem | None, bool]:
    score, why = await score_candidate(session, user_id=user_id, candidate=candidate, profile=profile)
    if candidate.get("source") == "trend":
        score += 20
        why = ["Recent connector trend", *why]
    elif candidate.get("source") == "external_web_search":
        score += 16
        why = ["Imported from external web search", *why]
    else:
        score += 8
        why = ["Recently found in connector search", *why]
    if candidate.get("source") == "rss_article":
        score += 14
        why = ["Recent RSS article", *why]
    if candidate.get("source") == "news_article":
        score += 12
        why = ["Recent news article", *why]
    if candidate.get("source") == "web_source":
        score += 10
        why = ["Recent web/article source", *why]
    if not candidate.get("source_id"):
        score += 5
        why.append("Novel item not yet saved as a source")

    url = candidate_url(candidate)
    summary = candidate_summary(candidate)
    row = await session.execute(
        select(DiscoveryItem).where(
            DiscoveryItem.user_id == user_id,
            DiscoveryItem.provider == candidate["provider"],
            DiscoveryItem.item_key == candidate["item_key"],
        )
    )
    item = row.scalar_one_or_none()
    is_saved_connector_candidate = (
        candidate.get("source") == "connector_cache" and bool(candidate.get("source_id"))
    )
    if item:
        if item.status in {"kept", "saved", "dismissed"}:
            return item, False
        if is_saved_connector_candidate:
            item.status = "saved"
            item.source_id = candidate["source_id"]
            item.reviewed_at = _utc_now_naive()
            return item, False
        item.title = candidate["title"]
        item.url = url
        item.summary = summary
        item.payload = candidate["payload"]
        item.score = round(score, 3)
        item.why = list(dict.fromkeys(why))[:6]
        item.source_id = candidate.get("source_id") or item.source_id
        return item, False

    if not is_saved_connector_candidate and not allow_recommended_create:
        return None, False

    source_id = candidate.get("source_id")
    item = DiscoveryItem(
        user_id=user_id,
        provider=candidate["provider"],
        item_key=candidate["item_key"],
        title=candidate["title"],
        url=url,
        summary=summary,
        payload=candidate["payload"],
        status="saved" if is_saved_connector_candidate else "recommended",
        score=round(score, 3),
        why=list(dict.fromkeys(why))[:6],
        source_id=source_id,
        reviewed_at=_utc_now_naive() if is_saved_connector_candidate else None,
    )
    session.add(item)
    return item, True


def _dedupe_candidates(candidates: list[dict]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    result: list[dict] = []
    for candidate in candidates:
        key = (candidate["provider"], candidate["item_key"])
        if key in seen:
            continue
        seen.add(key)
        result.append(candidate)
    return result


def discovery_item_key(provider: str, payload: dict) -> str:
    return connector_cache_key(provider, payload)


def _web_item_key(url: str) -> str:
    return "web:" + hashlib.sha1(url.strip().lower().encode()).hexdigest()[:24]


async def _load_profile(session: AsyncSession, user_id: str) -> dict:
    return await load_discovery_profile(session, user_id)


__all__ = [
    "_load_profile",
    "_upsert_discovery_item",
    "apply_discovery_feedback",
    "discovery_item_key",
    "generate_discovery_items",
    "refresh_discovery_recommendations",
    "import_github_repo",
    "ingest_web_discovery_results",
    "search_external_web_results",
]
