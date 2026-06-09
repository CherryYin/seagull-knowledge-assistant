import asyncio
import hashlib
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.models.connector_cache import ConnectorSearchItem
from pkg.models.connector_trend import ConnectorTrendItem
from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source
from pkg.services.foundation.connectors import import_github_repo
from pkg.services.foundation.connector_cache import connector_cache_key
from pkg.services.foundation.discovery_imports import domain_from_url, import_discovery_item, normalize_http_url
from pkg.services.foundation.discovery_profile import load_discovery_profile
from pkg.services.foundation.discovery_scoring import candidate_summary, candidate_url, score_candidate
from pkg.services.foundation.memory_retriever import retrieve_for_query
from pkg.services.foundation.source_memory import upsert_source_memory_node


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def generate_discovery_items(
    session: AsyncSession,
    *,
    user_id: str,
    providers: list[str] | None = None,
    limit: int = 50,
    commit: bool = True,
) -> tuple[int, int, int]:
    providers = providers or ["arxiv", "github", "rss", "web", "openalex", "crossref", "semantic_scholar"]
    profile = await load_discovery_profile(session, user_id)
    created = 0
    updated = 0
    skipped = 0
    candidates = await _load_candidates(session, user_id=user_id, providers=providers, limit=limit)
    for candidate in candidates[:limit]:
        item, was_created = await _upsert_discovery_item(session, user_id=user_id, candidate=candidate, profile=profile)
        if item.status in {"kept", "saved", "dismissed"}:
            skipped += 1
        elif was_created:
            created += 1
        else:
            updated += 1
    if commit:
        await session.commit()
    return created, updated, skipped


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


async def search_external_web_results(query: str, *, max_results: int = 10) -> list[dict]:
    if not settings.TAVILY_API_KEY:
        raise ValueError("TAVILY_API_KEY is not configured")
    from tavily import TavilyClient

    client = TavilyClient(api_key=settings.TAVILY_API_KEY)
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
    created = 0
    updated = 0
    skipped = 0
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
        item, was_created = await _upsert_discovery_item(session, user_id=user_id, candidate=candidate, profile=profile)
        if item.status in {"kept", "saved", "dismissed"}:
            skipped += 1
        elif was_created:
            created += 1
        else:
            updated += 1
    if commit:
        await session.commit()
    return created, updated, skipped


async def _load_candidates(session: AsyncSession, *, user_id: str, providers: list[str], limit: int) -> list[dict]:
    candidates: list[dict] = []
    cache_payloads = await _load_cache_payloads(session, user_id=user_id, providers=providers)

    if any(provider in providers for provider in ["arxiv", "github"]):
        rows = await session.execute(
            select(ConnectorSearchItem)
            .where(ConnectorSearchItem.user_id == user_id)
            .where(ConnectorSearchItem.provider.in_([provider for provider in providers if provider in {"arxiv", "github"}]))
            .order_by(ConnectorSearchItem.updated_at.desc())
            .limit(limit * 3)
        )
        for item in rows.scalars():
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

    if any(provider in providers for provider in ["github", "arxiv"]):
        trend_rows = await session.execute(
            select(ConnectorTrendItem)
            .where(ConnectorTrendItem.user_id == user_id)
            .where(ConnectorTrendItem.provider.in_([provider for provider in providers if provider in {"github", "arxiv"}]))
            .order_by(ConnectorTrendItem.updated_at.desc())
            .limit(limit * 2)
        )
        for trend in trend_rows.scalars():
            payload = cache_payloads.get((trend.provider, trend.item_key), trend.payload)
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

    if "rss" in providers or "web" in providers:
        source_rows = await session.execute(
            select(Source)
            .where(Source.user_id == user_id)
            .order_by(Source.ingested_at.desc())
            .limit(limit * 4)
        )
        for source in source_rows.scalars():
            raw_metadata = getattr(source, "metadata_", None)
            if not raw_metadata and hasattr(source, "__dict__"):
                raw_metadata = source.__dict__.get("metadata")
            metadata = dict(raw_metadata or {})
            if metadata.get("feed_source_id") and "rss" in providers:
                candidates.append({
                    "source": "rss_article",
                    "provider": "rss",
                    "item_key": source.id,
                    "title": source.title,
                    "payload": {
                        "source_id": source.id,
                        "title": source.title,
                        "url": source.url,
                        "summary": source.summary if hasattr(source, "summary") else None,
                        "source_name": metadata.get("source_name") or metadata.get("connector"),
                        "domain": metadata.get("domain") or domain_from_url(source.url or ""),
                        "published_at": metadata.get("published") or metadata.get("published_at"),
                    },
                    "base_score": 0,
                    "source_id": source.id,
                })
            elif source.source_type == "web" and "web" in providers:
                candidates.append({
                    "source": "web_source",
                    "provider": "web",
                    "item_key": _web_item_key(source.url or source.id),
                    "title": source.title,
                    "payload": {
                        "url": source.url,
                        "summary": source.summary if hasattr(source, "summary") else None,
                        "source_name": metadata.get("source_name") or metadata.get("connector"),
                        "domain": metadata.get("domain") or domain_from_url(source.url or ""),
                        "published_at": metadata.get("published_at"),
                    },
                    "base_score": 4,
                    "source_id": source.id,
                })
    else:
        await session.execute(select(Source).where(Source.user_id == user_id).limit(0))

    return _dedupe_candidates(candidates)


async def _load_cache_payloads(session: AsyncSession, *, user_id: str, providers: list[str]) -> dict[tuple[str, str], dict]:
    rows = await session.execute(
        select(ConnectorSearchItem)
        .where(ConnectorSearchItem.user_id == user_id)
        .where(ConnectorSearchItem.provider.in_(providers))
    )
    return {(item.provider, item.item_key): item.payload for item in rows.scalars()}


async def _upsert_discovery_item(session: AsyncSession, *, user_id: str, candidate: dict, profile: dict) -> tuple[DiscoveryItem, bool]:
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
    if item:
        if item.status in {"kept", "saved", "dismissed"}:
            return item, False
        item.title = candidate["title"]
        item.url = url
        item.summary = summary
        item.payload = candidate["payload"]
        item.score = round(score, 3)
        item.why = list(dict.fromkeys(why))[:6]
        item.source_id = candidate.get("source_id") or item.source_id
        return item, False

    item = DiscoveryItem(
        user_id=user_id,
        provider=candidate["provider"],
        item_key=candidate["item_key"],
        title=candidate["title"],
        url=url,
        summary=summary,
        payload=candidate["payload"],
        status="recommended",
        score=round(score, 3),
        why=list(dict.fromkeys(why))[:6],
        source_id=candidate.get("source_id"),
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
    "import_github_repo",
    "ingest_web_discovery_results",
    "retrieve_for_query",
    "search_external_web_results",
    "upsert_source_memory_node",
]
