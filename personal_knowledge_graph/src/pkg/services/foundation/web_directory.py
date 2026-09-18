import hashlib
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
from sqlalchemy import select, text as sql_text

from pkg.config import settings
from pkg.db import async_session
from pkg.models.foundation.source import Source
from pkg.schemas.source import SourceCreate
from pkg.services.foundation.web_extractor import WEB_FETCH_HEADERS, fetch_web_page
from pkg.services.foundation.web_source_roles import WEB_ROLE_ARTICLE, apply_web_source_role


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._region_stack: list[str] = []

    def _push_region(self, tag: str, attrs: dict[str, str | None]) -> None:
        tag_lower = tag.lower()
        role = (attrs.get("role") or "").lower()
        element_id = (attrs.get("id") or "").lower()
        class_name = (attrs.get("class") or "").lower()

        if tag_lower in {"main", "article"}:
            self._region_stack.append("content")
            return
        if tag_lower in {"nav", "header", "footer", "aside"} or role in {"navigation", "banner", "contentinfo", "complementary"}:
            self._region_stack.append("noise")
            return
        if any(token in f" {class_name} {element_id} " for token in (" sidebar ", " sidenav ", " toc ", " table-of-contents ", " breadcrumb ", " pagination ", " navbar ", " footer ", " header ")):
            self._region_stack.append("noise")
            return
        self._region_stack.append(self._region_stack[-1] if self._region_stack else "unknown")

    def _pop_region(self) -> None:
        if self._region_stack:
            self._region_stack.pop()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key.lower(): value for key, value in attrs}
        if tag != "a":
            self._push_region(tag, attr_map)
            return
        region = self._region_stack[-1] if self._region_stack else "unknown"
        for key, value in attrs:
            if key.lower() == "href" and value:
                self.links.append((value, region))

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a":
            self._pop_region()


@dataclass(slots=True)
class WebDirectoryImportResult:
    discovered: int
    imported: int
    updated: int
    skipped: int


def web_directory_metadata(source: Source) -> dict:
    return dict(source.metadata_ or {})


def is_web_directory_auto_discover_enabled(source: Source) -> bool:
    metadata = web_directory_metadata(source)
    return bool(metadata.get("auto_discover") is True)


def web_directory_discover_interval_hours(source: Source) -> int:
    metadata = web_directory_metadata(source)
    value = metadata.get("discover_interval_hours")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = settings.WEB_DIRECTORY_DISCOVER_INTERVAL_HOURS
    return max(parsed, 1)


def web_directory_max_articles_per_run(source: Source) -> int:
    metadata = web_directory_metadata(source)
    value = metadata.get("max_articles_per_run")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = settings.WEB_DIRECTORY_DISCOVER_MAX_ARTICLES_PER_RUN
    return max(parsed, 1)


def is_web_directory_discover_due(source: Source, *, now: datetime | None = None) -> bool:
    if not is_web_directory_auto_discover_enabled(source):
        return False
    metadata = web_directory_metadata(source)
    if metadata.get("content_source") != "web_directory" and metadata.get("web_directory") is not True:
        return False
    now = now or datetime.now(timezone.utc)
    last = metadata.get("last_auto_discovered_at")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except ValueError:
        return True
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    return now >= last_dt + timedelta(hours=web_directory_discover_interval_hours(source))


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

    target_path = parsed.path.rstrip("/")
    if not directory_path or not target_path:
        return False
    if target_path == directory_path:
        return False

    directory_parts = [part for part in directory_path.split("/") if part]
    target_parts = [part for part in target_path.split("/") if part]
    if len(target_parts) <= len(directory_parts):
        return False

    lower_target = target_path.lower()
    lower_directory = directory_path.lower()

    if any(part in lower_target for part in (
        "/tag/", "/tags/", "/category/", "/categories/", "/page/", "/search", "/releases", "/changelog",
    )):
        return False

    last_part = target_parts[-1].lower()
    if last_part in {"next", "previous", "prev", "index", "overview", "home"}:
        return False

    if target_path.startswith(directory_path + "/"):
        return True

    is_docs_directory = any(part in {"docs", "doc", "documentation"} for part in directory_parts)
    if is_docs_directory:
        shared_prefix = 0
        for left, right in zip(directory_parts, target_parts):
            if left == right:
                shared_prefix += 1
            else:
                break
        if shared_prefix >= max(2, min(len(directory_parts), 3)):
            if len(target_parts) >= shared_prefix + 1 and lower_target != lower_directory:
                return True

    return False


def discover_article_links(html: str, *, directory_url: str) -> list[str]:
    parser = _LinkParser()
    parser.feed(html)
    ranked_links: dict[str, tuple[int, str]] = {}
    for href, region in parser.links:
        normalized = _normalize_link(directory_url, href)
        if not normalized:
            continue
        if not _looks_like_article_url(normalized, directory_url=directory_url):
            continue
        priority = 2 if region == "content" else 1 if region != "noise" else 0
        existing = ranked_links.get(normalized)
        if existing is None or priority > existing[0]:
            ranked_links[normalized] = (priority, normalized)

    preferred_links = [url for priority, url in ranked_links.values() if priority == 2]
    if preferred_links:
        return preferred_links
    return [url for priority, url in ranked_links.values() if priority == 1]


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
            if existing.content_hash == content_hash:
                skipped += 1
                continue

            existing.title = page.title or existing.title
            existing.url = page.final_url
            existing.metadata_ = apply_web_source_role({
                **existing_meta,
                **page.metadata,
                "feed_source_id": directory_source.id,
                "article_url": page.final_url,
                "content_source": "web_directory",
                "web_directory_url": directory_source.url,
            }, role=WEB_ROLE_ARTICLE, origin="web_directory", collection_source_id=directory_source.id)
            await _update_source_content(existing, page.text, session)
            updated += 1
            continue

        metadata = apply_web_source_role({
            **page.metadata,
            "feed_source_id": directory_source.id,
            "article_url": page.final_url,
            "content_source": "web_directory",
            "web_directory_url": directory_source.url,
            "review_status": "imported_reviewable",
        }, role=WEB_ROLE_ARTICLE, origin="web_directory", collection_source_id=directory_source.id)
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


async def run_web_directory_discover_step() -> dict:
    from sqlalchemy import select

    now = datetime.now(timezone.utc)
    stats = {
        "sources_considered": 0,
        "sources_due": 0,
        "sources_processed": 0,
        "discovered": 0,
        "imported": 0,
        "updated": 0,
        "skipped": 0,
        "errors": 0,
        "reason": None,
    }

    async with async_session() as session:
        rows = await session.execute(
            select(Source)
            .where(Source.source_type == "web")
            .order_by(Source.ingested_at.desc())
            .limit(settings.WEB_DIRECTORY_DISCOVER_MAX_SOURCES_PER_RUN)
        )
        sources = list(rows.scalars())

    due_sources = [source for source in sources if is_web_directory_discover_due(source, now=now)]
    stats["sources_considered"] = len(sources)
    stats["sources_due"] = len(due_sources)

    if not due_sources:
        stats["reason"] = "no_due_web_directories"
        return stats

    async with async_session() as session:
        for source in due_sources:
            source_obj = await session.get(Source, source.id)
            if not source_obj:
                continue
            try:
                result = await import_web_directory_articles(
                    session,
                    source_obj,
                    limit=web_directory_max_articles_per_run(source_obj),
                )
                metadata = web_directory_metadata(source_obj)
                metadata["last_auto_discovered_at"] = now.isoformat()
                metadata["auto_discover"] = metadata.get("auto_discover") is True
                source_obj.metadata_ = metadata
                await session.commit()
                stats["sources_processed"] += 1
                stats["discovered"] += result.discovered
                stats["imported"] += result.imported
                stats["updated"] += result.updated
                stats["skipped"] += result.skipped
            except Exception:
                stats["errors"] += 1
                await session.rollback()

    return stats


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
