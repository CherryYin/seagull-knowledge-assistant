import hashlib
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
from sqlalchemy import select, text as sql_text

from pkg.config import settings
from pkg.models.foundation.source import Source
from pkg.schemas.source import SourceCreate
from pkg.services.foundation.web_extractor import WEB_FETCH_HEADERS, fetch_web_page


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        for key, value in attrs:
            if key.lower() == "href" and value:
                self.links.append(value)


@dataclass(slots=True)
class WebDirectoryImportResult:
    discovered: int
    imported: int
    updated: int
    skipped: int


def _normalize_link(base_url: str, href: str) -> str | None:
    absolute = urldefrag(urljoin(base_url, href.strip()))[0].rstrip("/")
    parsed = urlparse(absolute)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return absolute


def _looks_like_article_url(url: str, *, directory_url: str) -> bool:
    parsed = urlparse(url)
    directory = urlparse(directory_url.rstrip("/"))
    directory_path = directory.path.rstrip("/")
    if parsed.netloc != directory.netloc:
        return False
    if not directory_path or not parsed.path.startswith(directory_path + "/"):
        return False
    if parsed.path.rstrip("/") == directory_path:
        return False
    if any(part in parsed.path.lower() for part in ("/tag/", "/category/", "/page/")):
        return False
    return True


def discover_article_links(html: str, *, directory_url: str) -> list[str]:
    parser = _LinkParser()
    parser.feed(html)
    links: list[str] = []
    seen: set[str] = set()
    for href in parser.links:
        normalized = _normalize_link(directory_url, href)
        if not normalized or normalized in seen:
            continue
        if not _looks_like_article_url(normalized, directory_url=directory_url):
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


async def fetch_directory_article_links(directory_url: str, *, limit: int = 50) -> list[str]:
    async with httpx.AsyncClient(timeout=settings.RSS_FETCH_TIMEOUT, headers=WEB_FETCH_HEADERS, follow_redirects=True) as client:
        response = await client.get(directory_url)
        response.raise_for_status()
    return discover_article_links(response.text, directory_url=str(response.url))[:limit]


async def import_web_directory_articles(
    session,
    directory_source: Source,
    *,
    limit: int = 50,
) -> WebDirectoryImportResult:
    if not directory_source.url:
        return WebDirectoryImportResult(discovered=0, imported=0, updated=0, skipped=0)

    from pkg.api.sources import persist_source
    from pkg.services.foundation.rss_fetcher import _update_source_content

    article_links = await fetch_directory_article_links(directory_source.url, limit=limit)
    imported = 0
    updated = 0
    skipped = 0
    for link in article_links:
        try:
            page = await fetch_web_page(link)
        except Exception:
            skipped += 1
            continue

        content_hash = hashlib.sha256(page.text.encode()).hexdigest()
        existing = await _find_existing_directory_article(session, directory_source, page.final_url)
        if existing:
            existing_meta = dict(existing.metadata_ or {})
            fetched_updated_at = page.metadata.get("web_fetch_updated_at")
            existing_updated_at = existing_meta.get("web_fetch_updated_at")
            if fetched_updated_at and existing_updated_at == fetched_updated_at:
                skipped += 1
                continue
            if existing.content_hash == content_hash:
                skipped += 1
                continue

            existing.title = page.title or existing.title
            existing.url = page.final_url
            existing.metadata_ = {
                **existing_meta,
                **page.metadata,
                "feed_source_id": directory_source.id,
                "article_url": page.final_url,
                "content_source": "web_directory",
                "web_directory_url": directory_source.url,
            }
            await _update_source_content(existing, page.text, session)
            updated += 1
            continue

        metadata = {
            **page.metadata,
            "feed_source_id": directory_source.id,
            "article_url": page.final_url,
            "content_source": "web_directory",
            "web_directory_url": directory_source.url,
        }
        body = SourceCreate(
            title=page.title or link,
            source_type="web",
            category_id=directory_source.category_id,
            url=page.final_url,
            raw_content=page.text,
            metadata=metadata,
        )
        try:
            await persist_source(
                session=session,
                body=body,
                user_id=directory_source.user_id,
                content_hash_override=content_hash,
            )
            imported += 1
        except Exception:
            skipped += 1

    return WebDirectoryImportResult(discovered=len(article_links), imported=imported, updated=updated, skipped=skipped)


async def _find_existing_directory_article(session, directory_source: Source, article_url: str) -> Source | None:
    rows = await session.execute(
        select(Source).where(
            Source.user_id == directory_source.user_id,
            sql_text("metadata->>'feed_source_id' = :feed_id").bindparams(feed_id=directory_source.id),
            Source.url == article_url,
        ).limit(1)
    )
    existing = rows.scalar_one_or_none()
    if existing:
        return existing

    rows = await session.execute(
        select(Source).where(
            Source.user_id == directory_source.user_id,
            sql_text("metadata->>'feed_source_id' = :feed_id").bindparams(feed_id=directory_source.id),
            sql_text("metadata->>'article_url' = :article_url").bindparams(article_url=article_url),
        ).limit(1)
    )
    return rows.scalar_one_or_none()
