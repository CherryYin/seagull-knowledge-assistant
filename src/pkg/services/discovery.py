import asyncio
import hashlib
from datetime import datetime, timezone
from math import log1p
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.connector_cache import ConnectorSearchItem
from pkg.models.connector_trend import ConnectorTrendItem
from pkg.models.discovery import DiscoveryItem
from pkg.models.source import Source
from pkg.config import settings
from pkg.models.user import UserMemory
from pkg.schemas.connector import ArxivPaper, GitHubRepo
from pkg.services.connector_cache import connector_cache_key
from pkg.services.connectors import import_arxiv_paper, import_github_repo
from pkg.services.source_memory import upsert_source_memory_node
from pkg.services.memory_retriever import retrieve_for_query
from pkg.services.user_profiler import PROFILE_MEMORY_KEY


HIGH_QUALITY_DOMAINS = {
    "acm.org",
    "arxiv.org",
    "developer.mozilla.org",
    "docs.github.com",
    "github.com",
    "ieee.org",
    "nature.com",
    "openai.com",
    "pytorch.org",
    "sciencedirect.com",
    "springer.com",
    "stanford.edu",
}

LOW_QUALITY_DOMAIN_HINTS = ("medium.com", "substack.com")


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
    providers = providers or ["arxiv", "github", "rss", "web"]
    profile = await _load_profile(session, user_id)
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
    now = _utc_now_naive()
    item.feedback = {"action": action, "note": note, "at": now.isoformat()}
    item.reviewed_at = now
    source = None
    created = None

    if action in {"keep", "save"}:
        if item.source_id:
            source = await session.get(Source, item.source_id)
            created = False
        else:
            source, created, _dedupe = await _import_discovery_item(session, item)
        item.status = "saved" if action == "save" else "kept"
        if source:
            item.source_id = source.id
    elif action == "dismiss":
        item.status = "dismissed"

    await _update_profile_feedback(session, user_id=item.user_id, provider=item.provider, action=action, item=item)
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
        url = _normalize_http_url(url)
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
    profile = await _load_profile(session, user_id)
    created = 0
    updated = 0
    skipped = 0
    for raw_item in items:
        url = _normalize_http_url(str(raw_item.get("url") or "").strip())
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
            "domain": _domain_from_url(url),
            "discovery_source": "external_web_search",
        }
        candidate = {
            "source": "external_web_search",
            "provider": "web",
            "item_key": _web_item_key(url),
            "title": title,
            "payload": payload,
            "base_score": 0,
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


async def _load_candidates(
    session: AsyncSession,
    *,
    user_id: str,
    providers: list[str],
    limit: int,
) -> list[dict]:
    candidates: list[dict] = []
    cache_payloads = await _load_cache_payloads(session, user_id=user_id, providers=providers)
    trend_rows = await session.execute(
        select(ConnectorTrendItem)
        .where(ConnectorTrendItem.user_id == user_id)
        .where(ConnectorTrendItem.provider.in_(providers))
        .order_by(ConnectorTrendItem.trend_date.desc(), ConnectorTrendItem.rank.asc().nullslast())
        .limit(limit)
    )
    for trend in trend_rows.scalars():
        payload = dict(cache_payloads.get((trend.provider, trend.item_key)) or trend.metadata_ or {})
        candidates.append({"source": "trend", "provider": trend.provider, "item_key": trend.item_key, "title": trend.title, "payload": payload, "base_score": trend.score or 0, "source_id": trend.source_id})

    cache_rows = await session.execute(
        select(ConnectorSearchItem)
        .where(ConnectorSearchItem.user_id == user_id)
        .where(ConnectorSearchItem.provider.in_(providers))
        .where(ConnectorSearchItem.status != "saved")
        .order_by(ConnectorSearchItem.updated_at.desc())
        .limit(limit)
    )
    for cached in cache_rows.scalars():
        candidates.append({"source": "search_cache", "provider": cached.provider, "item_key": cached.item_key, "title": cached.title, "payload": cached.payload, "base_score": 0, "source_id": cached.source_id})
    if "rss" in providers:
        rss_rows = await session.execute(
            select(Source)
            .where(Source.user_id == user_id)
            .where(Source.source_type == "web")
            .where(Source.metadata_["feed_source_id"].astext.is_not(None))
            .order_by(Source.ingested_at.desc())
            .limit(limit)
        )
        for source in rss_rows.scalars():
            metadata = source.metadata_ or {}
            candidates.append({
                "source": "rss_article",
                "provider": "rss",
                "item_key": source.id,
                "title": source.title,
                "payload": {
                    "source_id": source.id,
                    "title": source.title,
                    "url": source.url,
                    "raw_content": source.raw_content,
                    "feed_source_id": metadata.get("feed_source_id"),
                    "published_at": metadata.get("published_at"),
                    "content_source": metadata.get("content_source"),
                },
                "base_score": 0,
                "source_id": source.id,
            })
    if "web" in providers:
        web_rows = await session.execute(
            select(Source)
            .where(Source.user_id == user_id)
            .where(Source.source_type.in_(["web", "article"]))
            .where(Source.metadata_["feed_source_id"].astext.is_(None))
            .order_by(Source.ingested_at.desc())
            .limit(limit)
        )
        for source in web_rows.scalars():
            metadata = source.metadata_ or {}
            candidates.append({
                "source": "web_source",
                "provider": "web",
                "item_key": source.id,
                "title": source.title,
                "payload": {
                    "source_id": source.id,
                    "title": source.title,
                    "url": source.url,
                    "raw_content": source.raw_content,
                    "source_type": source.source_type,
                    "connector": metadata.get("connector"),
                    "published_at": metadata.get("published") or metadata.get("published_at"),
                },
                "base_score": 0,
                "source_id": source.id,
            })
    return _dedupe_candidates(candidates)


async def _load_cache_payloads(session: AsyncSession, *, user_id: str, providers: list[str]) -> dict[tuple[str, str], dict]:
    rows = await session.execute(
        select(ConnectorSearchItem)
        .where(ConnectorSearchItem.user_id == user_id)
        .where(ConnectorSearchItem.provider.in_(providers))
    )
    return {(item.provider, item.item_key): item.payload for item in rows.scalars()}


async def _upsert_discovery_item(session: AsyncSession, *, user_id: str, candidate: dict, profile: dict) -> tuple[DiscoveryItem, bool]:
    score, why = _score_candidate(candidate, profile)
    memory_score, memory_reasons = await _memory_similarity_score(session, user_id=user_id, candidate=candidate)
    score += memory_score
    why.extend(memory_reasons)
    url = _candidate_url(candidate)
    summary = _candidate_summary(candidate)
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
        item.score = score
        item.why = why
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
        score=score,
        why=why,
        source_id=candidate.get("source_id"),
    )
    session.add(item)
    return item, True


def _score_candidate(candidate: dict, profile: dict) -> tuple[float, list[str]]:
    payload = candidate.get("payload") or {}
    score = float(candidate.get("base_score") or 0)
    why: list[str] = []
    if candidate.get("source") == "trend":
        score += 20
        why.append("Recent connector trend")
    elif candidate.get("source") == "external_web_search":
        score += 16
        why.append("Imported from external web search")
    else:
        score += 8
        why.append("Recently found in connector search")
    if candidate.get("source") == "rss_article":
        score += 14
        why.append("Recent RSS article")
    if candidate.get("source") == "web_source":
        score += 10
        why.append("Recent web/article source")

    if candidate["provider"] == "github":
        stars = int(payload.get("stars") or 0)
        score += min(log1p(stars) * 3, 30)
        if stars:
            why.append(f"GitHub popularity: {stars} stars")
        if payload.get("star_growth_7d"):
            why.append(f"Growing this week: +{payload['star_growth_7d']} stars")
    if candidate["provider"] == "arxiv":
        citations = int(payload.get("citation_count") or 0)
        score += min(log1p(citations) * 4, 25)
        if citations:
            why.append(f"Citation signal: {citations} citations")
    if candidate["provider"] == "rss":
        why.append("From a followed RSS feed")
    if candidate["provider"] == "web":
        why.append("From saved web knowledge")

    credibility_score, credibility_reason = _credibility_score(candidate)
    score += credibility_score
    if credibility_reason:
        why.append(credibility_reason)

    preference_score, preference_reason = _feedback_preference_score(candidate, profile)
    score += preference_score
    if preference_reason:
        why.append(preference_reason)

    matched = _profile_matches(candidate, profile)
    if matched:
        score += 18 + len(matched) * 2
        why.append("Matches profile interests: " + ", ".join(matched[:4]))
    if not candidate.get("source_id"):
        score += 5
        why.append("Novel item not yet saved as a source")
    elif not _payload_can_import(candidate["provider"], payload):
        why.append("Already saved as source; review existing source")
    return round(score, 3), why[:6]


async def _memory_similarity_score(session: AsyncSession, *, user_id: str, candidate: dict) -> tuple[float, list[str]]:
    query = " ".join([
        candidate.get("title") or "",
        str((candidate.get("payload") or {}).get("abstract") or "")[:500],
        str((candidate.get("payload") or {}).get("description") or "")[:500],
        str((candidate.get("payload") or {}).get("raw_content") or "")[:500],
    ]).strip()
    if not query:
        return 0.0, []
    try:
        results = await retrieve_for_query(session, user_id=user_id, query=query, limit=3)
    except Exception:
        return 0.0, []
    if not results:
        return 0.0, []
    top_titles = [result.node.title for result in results[:2] if getattr(result.node, "title", None)]
    if not top_titles:
        return 8.0, ["Similar to existing memory"]
    return 10.0, ["Similar to memory: " + ", ".join(top_titles)]


def _profile_matches(candidate: dict, profile: dict) -> list[str]:
    text = " ".join([
        candidate.get("title") or "",
        str((candidate.get("payload") or {}).get("abstract") or ""),
        str((candidate.get("payload") or {}).get("description") or ""),
        str((candidate.get("payload") or {}).get("raw_content") or "")[:2000],
        " ".join((candidate.get("payload") or {}).get("topics") or []),
        " ".join((candidate.get("payload") or {}).get("categories") or []),
    ]).lower()
    interests = profile.get("interests") if isinstance(profile.get("interests"), list) else []
    tokens: list[str] = []
    for interest in interests:
        if not isinstance(interest, dict):
            continue
        for value in (interest.get("domain"), interest.get("recent_focus")):
            if value and str(value).lower() in text:
                tokens.append(str(value))
    return list(dict.fromkeys(tokens))


def _credibility_score(candidate: dict) -> tuple[float, str | None]:
    payload = candidate.get("payload") or {}
    provider = candidate["provider"]
    if provider == "arxiv":
        citations = int(payload.get("citation_count") or 0)
        if citations >= 100:
            return 8.0, "High citation credibility"
        if payload.get("published") or payload.get("published_at"):
            return 3.0, "Dated research metadata available"
    if provider == "github":
        stars = int(payload.get("stars") or 0)
        forks = int(payload.get("forks") or 0)
        if stars >= 1000 or forks >= 100:
            return 8.0, "Strong repository credibility"
        if stars >= 100:
            return 4.0, "Moderate repository credibility"
    if provider in {"rss", "web"}:
        url = str(payload.get("url") or "")
        domain = _domain_from_url(url)
        if _is_high_quality_domain(domain):
            return 8.0, f"Trusted domain: {domain}"
        if any(domain == hint or domain.endswith(f".{hint}") for hint in LOW_QUALITY_DOMAIN_HINTS):
            return 1.0, "Personal publishing platform; review quality"
        if url.startswith("https://"):
            return 3.0, "HTTPS source"
    return 0.0, None


def _feedback_preference_score(candidate: dict, profile: dict) -> tuple[float, str | None]:
    feedback = profile.get("discovery_feedback") if isinstance(profile.get("discovery_feedback"), dict) else {}
    provider = candidate["provider"]
    provider_feedback = feedback.get(provider) if isinstance(feedback.get(provider), dict) else {}
    kept = int(provider_feedback.get("keep") or 0) + int(provider_feedback.get("save") or 0)
    dismissed = int(provider_feedback.get("dismiss") or 0)
    delta = kept - dismissed
    score = 0.0
    reasons: list[str] = []
    if delta > 0:
        score += min(delta * 2.0, 10.0)
        reasons.append("Boosted by your keep/save history")
    if delta < 0:
        score += max(delta * 2.0, -10.0)
        reasons.append("Downranked by your dismiss history")

    fine_score, fine_reasons = _fine_grained_preference_score(candidate, profile)
    score += fine_score
    reasons.extend(fine_reasons)
    return score, "; ".join(reasons[:2]) if reasons else None


def _fine_grained_preference_score(candidate: dict, profile: dict) -> tuple[float, list[str]]:
    preferences = profile.get("discovery_preferences") if isinstance(profile.get("discovery_preferences"), dict) else {}
    score = 0.0
    reasons: list[str] = []
    for group, values in _candidate_preference_signals(candidate).items():
        group_prefs = preferences.get(group) if isinstance(preferences.get(group), dict) else {}
        for value in values[:8]:
            stats = group_prefs.get(value) if isinstance(group_prefs.get(value), dict) else {}
            delta = int(stats.get("keep") or 0) + int(stats.get("save") or 0) - int(stats.get("dismiss") or 0)
            label = group[:-1] if group.endswith("s") else group
            if delta > 0:
                score += min(delta * 1.5, 6.0)
                reasons.append(f"Matches kept {label}: {value}")
            elif delta < 0:
                score -= min(abs(delta) * 1.5, 6.0)
                reasons.append(f"Downranked dismissed {label}: {value}")
    return score, list(dict.fromkeys(reasons))[:2]


def _candidate_url(candidate: dict) -> str | None:
    payload = candidate.get("payload") or {}
    return payload.get("html_url") or payload.get("entry_url") or payload.get("url")


def _candidate_summary(candidate: dict) -> str | None:
    payload = candidate.get("payload") or {}
    summary = payload.get("abstract") or payload.get("description") or payload.get("summary") or payload.get("raw_content")
    if isinstance(summary, str) and len(summary) > 700:
        return summary[:700].rstrip() + "…"
    return summary


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


async def _load_profile(session: AsyncSession, user_id: str) -> dict:
    row = await session.execute(select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PROFILE_MEMORY_KEY))
    profile = row.scalar_one_or_none()
    return dict(profile.value or {}) if profile else {}


async def _update_profile_feedback(session: AsyncSession, *, user_id: str, provider: str, action: str, item: DiscoveryItem | None = None) -> None:
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
        for group, values in _candidate_preference_signals({"provider": item.provider, "payload": item.payload or {}}).items():
            group_prefs = dict(preferences.get(group) or {})
            for signal in values[:12]:
                stats = dict(group_prefs.get(signal) or {})
                stats[action] = int(stats.get(action) or 0) + 1
                group_prefs[signal] = stats
            preferences[group] = group_prefs
        value["discovery_preferences"] = preferences

    profile.value = value


async def _import_discovery_item(session: AsyncSession, item: DiscoveryItem):
    payload = dict(item.payload or {})
    payload.setdefault("source_id", item.source_id)
    if item.provider == "arxiv":
        if not _payload_can_import("arxiv", payload):
            raise ValueError("Discovery item does not contain enough arXiv payload to import")
        paper = ArxivPaper(**payload)
        source, created, dedupe = await import_arxiv_paper(session, user_id=item.user_id, paper=paper)
        return source, created, dedupe
    if item.provider == "github":
        if not _payload_can_import("github", payload):
            raise ValueError("Discovery item does not contain enough GitHub payload to import")
        repo = GitHubRepo(**payload)
        source, created, dedupe = await import_github_repo(session, user_id=item.user_id, repo=repo)
        return source, created, dedupe
    if item.provider == "web":
        return await _import_web_discovery_item(session, item, payload)
    raise ValueError(f"Unsupported discovery provider: {item.provider}")


def discovery_item_key(provider: str, payload: dict) -> str:
    return connector_cache_key(provider, payload)


def _payload_can_import(provider: str, payload: dict) -> bool:
    if provider == "arxiv":
        return bool(payload.get("arxiv_id") and payload.get("title") and payload.get("abstract") is not None)
    if provider == "github":
        return bool(payload.get("full_name") and payload.get("html_url"))
    return False


def _candidate_preference_signals(candidate: dict) -> dict[str, list[str]]:
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


def _normalize_http_url(url: str) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return url


def _domain_from_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower().split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def _is_high_quality_domain(domain: str) -> bool:
    if not domain:
        return False
    return any(domain == trusted or domain.endswith(f".{trusted}") for trusted in HIGH_QUALITY_DOMAINS)


def _web_item_key(url: str) -> str:
    return "web:" + hashlib.sha1(url.strip().lower().encode()).hexdigest()[:24]


def _web_source_id(user_id: str, url: str) -> str:
    user_hash = hashlib.sha1(user_id.encode()).hexdigest()[:8]
    url_hash = hashlib.sha1(url.strip().lower().encode()).hexdigest()[:16]
    return f"src-web-{user_hash}-{url_hash}"


async def _import_web_discovery_item(session: AsyncSession, item: DiscoveryItem, payload: dict) -> tuple[Source, bool, str]:
    url = _normalize_http_url(str(payload.get("url") or item.url or "").strip())
    if not url:
        raise ValueError("Discovery item does not contain a valid http(s) URL to import")
    source_id = _web_source_id(item.user_id, url)
    dedupe_key = f"web:{url.lower()}"
    metadata = {
        "connector": "web_discovery",
        "dedupe_key": dedupe_key,
        "discovery_item_id": item.id,
        "discovery_query": payload.get("query"),
        "source_name": payload.get("source_name"),
        "domain": payload.get("domain") or _domain_from_url(url),
        "published_at": payload.get("published_at"),
        "retention": "permanent",
        "kept_at": _utc_now_naive().isoformat(),
        "review_status": "imported_reviewable",
    }
    raw_content = "\n".join(part for part in [
        item.title,
        payload.get("summary"),
        f"URL: {url}",
        f"Discovery query: {payload.get('query')}" if payload.get("query") else None,
    ] if part)
    existing = await session.get(Source, source_id)
    if existing:
        if existing.user_id != item.user_id:
            raise ValueError("A source with this Web URL already exists for another user")
        existing.title = item.title
        existing.source_type = "web"
        existing.url = url
        existing.raw_content = raw_content
        existing.metadata_ = {**(existing.metadata_ or {}), **metadata}
        try:
            await upsert_source_memory_node(session, existing)
        except Exception:
            pass
        return existing, False, dedupe_key

    source = Source(
        id=source_id,
        user_id=item.user_id,
        category_id=1,
        title=item.title,
        source_type="web",
        url=url,
        raw_content=raw_content,
        content_hash=hashlib.sha256(raw_content.encode()).hexdigest(),
        metadata_=metadata,
    )
    session.add(source)
    try:
        await upsert_source_memory_node(session, source)
    except Exception:
        pass
    return source, True, dedupe_key
