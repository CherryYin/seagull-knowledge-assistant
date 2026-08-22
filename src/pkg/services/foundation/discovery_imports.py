import hashlib
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source
from pkg.schemas.connector import ArxivPaper, GitHubRepo
from pkg.services.foundation.connectors import import_arxiv_paper, import_github_repo


def utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def import_discovery_item(session: AsyncSession, item: DiscoveryItem):
    payload = dict(item.payload or {})
    payload.setdefault("source_id", item.source_id)
    if item.provider == "arxiv":
        if not payload_can_import("arxiv", payload):
            raise ValueError("Discovery item does not contain enough arXiv payload to import")
        paper = ArxivPaper(**payload)
        source, created, dedupe = await import_arxiv_paper(session, user_id=item.user_id, paper=paper)
        return source, created, dedupe
    if item.provider == "github":
        if not payload_can_import("github", payload):
            raise ValueError("Discovery item does not contain enough GitHub payload to import")
        repo = GitHubRepo(**payload)
        source, created, dedupe = await import_github_repo(session, user_id=item.user_id, repo=repo)
        return source, created, dedupe
    if item.provider == "web":
        return await import_web_discovery_item(session, item, payload)
    if item.provider in {"openalex", "crossref", "semantic_scholar"}:
        return await import_external_paper_discovery_item(session, item, payload)
    raise ValueError(f"Unsupported discovery provider: {item.provider}")


def payload_can_import(provider: str, payload: dict) -> bool:
    if provider == "arxiv":
        return bool(payload.get("arxiv_id") and payload.get("title") and payload.get("abstract") is not None)
    if provider == "github":
        return bool(payload.get("full_name") and payload.get("html_url"))
    return False


def normalize_http_url(url: str) -> str | None:
    from urllib.parse import urlparse

    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return url


def domain_from_url(url: str) -> str:
    from urllib.parse import urlparse

    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower().split("@")[ -1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def web_source_id(user_id: str, url: str) -> str:
    return f"src-web-{hashlib.sha1(f'{user_id}:{url.lower()}'.encode()).hexdigest()[:16]}"


def paper_source_id(user_id: str, provider: str, item_key: str) -> str:
    return f"src-paper-{provider}-{hashlib.sha1(f'{user_id}:{item_key}'.encode()).hexdigest()[:16]}"


def paper_raw_content(item: DiscoveryItem, payload: dict) -> str:
    parts = [item.title]
    if payload.get("authors"):
        parts.append(f"Authors: {', '.join(payload.get('authors') or [])}")
    if payload.get("venue"):
        parts.append(f"Venue: {payload.get('venue')}")
    if payload.get("year"):
        parts.append(f"Year: {payload.get('year')}")
    if payload.get("doi"):
        parts.append(f"DOI: {payload.get('doi')}")
    if payload.get("arxiv_id"):
        parts.append(f"arXiv: {payload.get('arxiv_id')}")
    if payload.get("url") or item.url:
        parts.append(f"URL: {payload.get('url') or item.url}")
    if payload.get("pdf_url"):
        parts.append(f"PDF: {payload.get('pdf_url')}")
    if payload.get("fields_of_study"):
        parts.append(f"Fields: {', '.join(payload.get('fields_of_study') or [])}")
    abstract = payload.get("abstract") or item.summary
    parts.extend(["", "## Abstract", abstract or "No abstract available."])
    return "\n".join(str(part) for part in parts if part is not None)


async def import_external_paper_discovery_item(session: AsyncSession, item: DiscoveryItem, payload: dict) -> tuple[Source, bool, str]:
    if not item.title:
        raise ValueError("Discovery item does not contain a paper title to import")
    source_id = paper_source_id(item.user_id, item.provider, item.item_key)
    dedupe_key = f"{item.provider}:{item.item_key}"
    metadata = {
        "connector": item.provider,
        "dedupe_key": dedupe_key,
        "discovery_item_id": item.id,
        "paper_provider_id": payload.get("paper_provider_id") or payload.get("provider_id"),
        "paper_profile_id": payload.get("paper_profile_id"),
        "paper_run_id": payload.get("paper_run_id"),
        "paper_query": payload.get("paper_query"),
        "paper_query_label": payload.get("paper_query_label"),
        "authors": payload.get("authors") or [],
        "fields_of_study": payload.get("fields_of_study") or [],
        "venue": payload.get("venue"),
        "year": payload.get("year"),
        "citation_count": payload.get("citation_count"),
        "reference_count": payload.get("reference_count"),
        "doi": payload.get("doi"),
        "arxiv_id": payload.get("arxiv_id"),
        "pdf_url": payload.get("pdf_url"),
        "entry_url": payload.get("url") or item.url,
        "review_status": "imported_reviewable",
        "retention": "permanent",
        "kept_at": utc_now_naive().isoformat(),
    }
    raw_content = paper_raw_content(item, payload)
    existing = await session.get(Source, source_id)
    if existing:
        if existing.user_id != item.user_id:
            raise ValueError("A source with this paper already exists for another user")
        existing.title = item.title
        existing.source_type = "article"
        existing.url = payload.get("url") or item.url
        existing.raw_content = raw_content
        existing.metadata_ = {**(existing.metadata_ or {}), **metadata}
        return existing, False, dedupe_key

    source = Source(
        id=source_id,
        user_id=item.user_id,
        category_id=1,
        title=item.title,
        source_type="article",
        url=payload.get("url") or item.url,
        raw_content=raw_content,
        content_hash=hashlib.sha256(raw_content.encode()).hexdigest(),
        metadata_=metadata,
    )
    session.add(source)
    return source, True, dedupe_key


async def import_web_discovery_item(session: AsyncSession, item: DiscoveryItem, payload: dict) -> tuple[Source, bool, str]:
    url = normalize_http_url(str(payload.get("url") or item.url or "").strip())
    if not url:
        raise ValueError("Discovery item does not contain a valid http(s) URL to import")
    source_id = web_source_id(item.user_id, url)
    dedupe_key = f"web:{url.lower()}"
    metadata = {
        "connector": "web_discovery",
        "dedupe_key": dedupe_key,
        "discovery_item_id": item.id,
        "discovery_query": payload.get("query"),
        "source_name": payload.get("source_name"),
        "domain": payload.get("domain") or domain_from_url(url),
        "published_at": payload.get("published_at"),
        "retention": "permanent",
        "kept_at": utc_now_naive().isoformat(),
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
    return source, True, dedupe_key
