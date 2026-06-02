"""RSS feed fetcher — fetches articles from RSS-enabled web sources.

Two modes depending on feed structure:

1. **Topic feed** (e.g. Discourse topic): all entries belong to the same page.
   Merges all posts/replies into one document and writes it back to the parent
   source's raw_content (no child sources created).

2. **Collection feed** (e.g. /latest.rss, blog index): each entry is a separate
   article.  Creates independent Source records per entry.
"""
import asyncio
import hashlib
import logging
import re
import time
from datetime import datetime, timedelta, timezone

import feedparser
import httpx
from sqlalchemy import select, text, delete
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.source import Source, SourceChunk, SourceEmbedding
from pkg.services.storage import get_storage_service

logger = logging.getLogger(__name__)

_FEED_CONCURRENCY = 5
_ARTICLE_FETCH_TIMEOUT = 20
_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_MIN_RSS_CONTENT_LEN = 200
_TECH_KEYWORDS = (
    "ai", "api", "llm", "gpt", "claude", "gemini", "deepseek", "qwen", "模型", "大模型",
    "agent", "mcp", "rag", "embedding", "向量", "prompt", "提示词", "token", "推理",
    "代码", "编程", "开发", "开源", "github", "repo", "仓库", "python", "javascript", "typescript",
    "rust", "go", "java", "docker", "k8s", "linux", "wsl", "数据库", "postgres", "redis",
    "算法", "架构", "系统", "部署", "服务器", "网络", "安全", "风控", "爬虫", "自动化",
    "cursor", "codex", "antigravity", "vscode", "trae", "cherry", "cline", "opencode",
)
_LOW_VALUE_TITLE_KEYWORDS = (
    "签到", "水贴", "水一贴", "灌水", "闲聊", "日常", "树洞", "吐槽", "表情包", "摸鱼",
    "祝", "生日", "520", "99天", "垃圾桶", "寻宝", "交友", "相亲", "工资", "待遇",
    "邀请码", "邀请", "求邀", "pt邀请", "邮箱", "hotmail", "gmail", "visa卡", "免费visa",
    "社区", "版规", "管理", "删帖", "移除", "封禁", "等级", "升级", "个性化", "佬友",
)
_COMMUNITY_MAINTENANCE_KEYWORDS = (
    "社区工作", "社区维护", "版规", "管理公告", "删帖", "移除", "封禁", "等级", "站务", "水区",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mark_fetch_meta(meta: dict, status: str, **extra) -> None:
    """Record the latest RSS fetch attempt in source metadata."""
    meta["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    meta["last_fetch_status"] = status
    if status == "ok":
        meta.pop("last_fetch_error", None)
    for key, value in extra.items():
        if value is not None:
            meta[key] = value


def _should_use_conditional_request(meta: dict) -> bool:
    return meta.get("use_conditional_requests") is True

def _article_hash(entry: dict) -> str:
    """Compute a stable dedup hash from a feed entry's guid or link."""
    key = entry.get("id") or entry.get("link") or entry.get("title", "")
    return hashlib.sha256(key.encode()).hexdigest()


def _html_to_text(html: str) -> str:
    """Convert HTML to clean plain text."""
    if not html.strip():
        return ""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    # Remove "Read full topic" / "阅读完整话题" trailing links
    for a in soup.find_all("a"):
        text = a.get_text(strip=True)
        if text in ("Read full topic", "阅读完整话题"):
            parent = a.parent
            if parent and parent.name == "p":
                parent.decompose()
            else:
                a.decompose()
    return soup.get_text(separator="\n", strip=True)


def _extract_rss_content(entry: dict) -> str:
    """Extract clean text from a feed entry's HTML content/summary."""
    html = ""
    if entry.get("content"):
        parts = [c.get("value", "") for c in entry["content"]]
        html = "\n\n".join(parts)
    if not html.strip():
        html = entry.get("summary", "") or entry.get("title", "")
    return _html_to_text(html)


def _extract_published(entry: dict) -> str | None:
    """Extract ISO-format published date from a feed entry."""
    for field in ("published_parsed", "updated_parsed"):
        tp = entry.get(field)
        if tp:
            try:
                dt = datetime(*tp[:6], tzinfo=timezone.utc)
                return dt.isoformat()
            except Exception:
                pass
    return entry.get("published") or entry.get("updated")


def _rss_filter_reason(title: str, content: str, metadata: dict | None = None) -> str | None:
    """Return a low-value reason for RSS/web entries that should not become sources."""
    if not settings.RSS_FILTER_LOW_VALUE:
        return None
    metadata = metadata or {}
    text = f"{title}\n{content}".lower()
    title_text = title.lower()

    if metadata.get("rss_keep") is True:
        return None

    if any(keyword.lower() in text for keyword in _COMMUNITY_MAINTENANCE_KEYWORDS):
        if not _has_tech_signal(text):
            return "community_maintenance"

    if any(keyword.lower() in title_text for keyword in _LOW_VALUE_TITLE_KEYWORDS):
        if not _has_tech_signal(text):
            return "non_technical_daily_topic"

    if len(content.strip()) < 80 and not _has_tech_signal(text):
        return "too_short_non_technical"

    return None


def _has_tech_signal(text: str) -> bool:
    return any(keyword.lower() in text for keyword in _TECH_KEYWORDS)


async def _fetch_article_content(url: str, client: httpx.AsyncClient) -> str | None:
    """Fetch the full article page and extract main text via trafilatura."""
    if not url:
        return None
    try:
        resp = await client.get(url, follow_redirects=True)
        if resp.status_code >= 400:
            return None
        import trafilatura
        text = trafilatura.extract(
            resp.text,
            include_comments=False,
            include_tables=True,
            output_format="txt",
        )
        return text if text and len(text) > 50 else None
    except Exception as exc:
        logger.debug("Failed to fetch article content from %s: %s", url, exc)
        return None


# ---------------------------------------------------------------------------
# Topic vs collection detection
# ---------------------------------------------------------------------------

def _is_single_topic_feed(entries: list[dict]) -> bool:
    """True when all entries are posts within the same topic/page."""
    if len(entries) <= 1:
        return True
    topic_keys: set[str] = set()
    for e in entries:
        link = e.get("link", "")
        match = re.search(r"/t/(?:[^/]+/)?(\d+)(?:/\d+)?/?$", link)
        if not match:
            return False
        topic_keys.add(match.group(1))
    return len(topic_keys) == 1


def _post_number(entry: dict) -> int:
    link = entry.get("link", "")
    m = re.search(r"/(\d+)$", link)
    return int(m.group(1)) if m else 0


def _merge_topic_entries(feed, entries: list[dict]) -> str:
    """Merge all entries of a topic feed into one document."""
    title = feed.feed.get("title", "")
    sorted_entries = sorted(entries, key=_post_number)

    parts: list[str] = []
    if title:
        parts.append(f"# {title}\n")

    channel_desc = _html_to_text(feed.feed.get("description", ""))
    has_post_1 = any(_post_number(e) <= 1 for e in entries)
    if channel_desc and not has_post_1:
        parts.append(f"## Original Post\n\n{channel_desc}")

    for entry in sorted_entries:
        author = entry.get("author", "") or (
            entry.get("dc_creator", "")
        )
        text = _extract_rss_content(entry)
        if not text:
            continue

        pn = _post_number(entry)
        if pn <= 1:
            header = "## Original Post"
        else:
            header = f"## Reply #{pn - 1}"
        if author:
            header += f" — {author}"

        parts.append(f"{header}\n\n{text}")

    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------------------
# Core fetch logic
# ---------------------------------------------------------------------------

async def _update_source_content(
    source: Source,
    raw_content: str,
    session: AsyncSession,
) -> None:
    """Update an existing source's raw_content and re-generate embeddings/chunks."""
    from pkg.services.embedding import get_embedding_service
    from pkg.services.chunking import chunk_text

    source.raw_content = raw_content.replace("\x00", "")
    source.content_hash = hashlib.sha256(raw_content.encode()).hexdigest()

    # Clear old embeddings and chunks
    await session.execute(
        delete(SourceEmbedding).where(SourceEmbedding.source_id == source.id)
    )
    await session.execute(
        delete(SourceChunk).where(SourceChunk.source_id == source.id)
    )

    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(source.title)
        summary_vec = await emb_svc.embed_text(raw_content[:2000] if raw_content else source.title)
        session.add(SourceEmbedding(source_id=source.id, title_vec=title_vec, summary_vec=summary_vec))

        if raw_content:
            chunks = chunk_text(raw_content)
            if chunks:
                vectors = await emb_svc.embed_batch(chunks)
                for idx, (chunk_content, vec) in enumerate(zip(chunks, vectors)):
                    session.add(SourceChunk(
                        source_id=source.id,
                        chunk_index=idx,
                        content=chunk_content,
                        embedding=vec,
                    ))
    except Exception:
        logger.error(
            "Embedding generation failed for source %s — saving without embeddings",
            source.id, exc_info=True,
        )

    try:
        from pkg.services.source_memory import upsert_source_memory_node

        await upsert_source_memory_node(session, source)
    except Exception:
        logger.error("Source memory generation failed for source %s", source.id, exc_info=True)


async def fetch_single_feed(feed_source: Source, session: AsyncSession) -> int:
    """Fetch a single RSS feed and persist new articles. Returns count of new articles."""
    meta = dict(feed_source.metadata_ or {})
    feed_url = meta.get("feed_url") or feed_source.url
    if not feed_url:
        return 0

    headers: dict[str, str] = {**_HTTP_HEADERS}
    if _should_use_conditional_request(meta) and meta.get("etag"):
        headers["If-None-Match"] = meta["etag"]
    if _should_use_conditional_request(meta) and meta.get("last_modified"):
        headers["If-Modified-Since"] = meta["last_modified"]

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=settings.RSS_FETCH_TIMEOUT) as client:
            resp = await client.get(feed_url, headers=headers, follow_redirects=True)
    except httpx.HTTPError as exc:
        logger.error(
            "RSS fetch HTTP error for source=%s url=%s: %s",
            feed_source.id, feed_url, exc,
        )
        _mark_fetch_meta(meta, "error", last_fetch_error=str(exc))
        feed_source.metadata_ = meta
        await session.commit()
        return 0

    if resp.status_code == 304:
        logger.info("RSS feed not modified: source=%s", feed_source.id)
        _mark_fetch_meta(meta, "not_modified", http_status=resp.status_code)
        feed_source.metadata_ = meta
        await session.commit()
        return 0

    if resp.status_code >= 400:
        logger.error(
            "RSS fetch failed: source=%s status=%d url=%s",
            feed_source.id, resp.status_code, feed_url,
        )
        _mark_fetch_meta(meta, "error", http_status=resp.status_code)
        feed_source.metadata_ = meta
        await session.commit()
        return 0

    feed = feedparser.parse(resp.content)
    if feed.bozo and not feed.entries:
        parse_error = str(feed.get("bozo_exception", "unknown"))
        logger.error(
            "RSS parse error for source=%s: %s",
            feed_source.id, feed.get("bozo_exception", "unknown"),
        )
        _mark_fetch_meta(meta, "error", last_fetch_error=parse_error)
        feed_source.metadata_ = meta
        await session.commit()
        return 0

    entries = feed.entries[:settings.RSS_MAX_ARTICLES_PER_FEED]

    # ── Topic feed: merge into parent source ──────────────────────────
    if _is_single_topic_feed(entries):
        merged = _merge_topic_entries(feed, entries)
        new_hash = hashlib.sha256(merged.encode()).hexdigest()

        if new_hash != feed_source.content_hash:
            await _update_source_content(feed_source, merged, session)
            _mark_fetch_meta(meta, "ok")
            meta["last_fetch_count"] = len(entries)
            meta["feed_type"] = "topic"
            feed_source.metadata_ = meta
            await session.commit()
            elapsed = time.monotonic() - start
            logger.info(
                "RSS topic merged: source=%s entries=%d elapsed=%.1fs",
                feed_source.id, len(entries), elapsed,
            )
            return 1  # one source updated

        _mark_fetch_meta(meta, "ok", last_fetch_count=0)
        feed_source.metadata_ = meta
        await session.commit()
        logger.info("RSS topic unchanged: source=%s", feed_source.id)
        return 0

    # ── Collection feed: one source per entry ─────────────────────────
    existing_hashes: set[str] = set()
    hash_list = [_article_hash(e) for e in entries]
    if hash_list:
        result = await session.execute(
            select(Source.content_hash).where(Source.content_hash.in_(hash_list))
        )
        existing_hashes = {row[0] for row in result}

    from pkg.api.sources import persist_source
    from pkg.schemas.source import SourceCreate

    new_count = 0
    async with httpx.AsyncClient(timeout=_ARTICLE_FETCH_TIMEOUT, headers=_HTTP_HEADERS) as article_client:
        for entry in entries:
            content_hash = _article_hash(entry)
            if content_hash in existing_hashes:
                continue

            title = entry.get("title", "Untitled")
            article_url = entry.get("link", "")
            published_at = _extract_published(entry)

            rss_text = _extract_rss_content(entry)
            content_source = "rss"

            if len(rss_text) >= _MIN_RSS_CONTENT_LEN:
                raw_content = rss_text
            else:
                page_text = await _fetch_article_content(article_url, article_client)
                if page_text:
                    raw_content = page_text
                    content_source = "page"
                else:
                    raw_content = rss_text or title

            article_meta = {
                "feed_source_id": feed_source.id,
                "article_url": article_url,
                "published_at": published_at,
                "guid": entry.get("id", ""),
                "content_source": content_source,
            }

            filter_reason = _rss_filter_reason(title, raw_content, article_meta)
            if filter_reason:
                logger.info(
                    "RSS article filtered: feed=%s reason=%s title=%s",
                    feed_source.id,
                    filter_reason,
                    title,
                )
                meta["last_filtered_count"] = int(meta.get("last_filtered_count", 0)) + 1
                continue

            body = SourceCreate(
                title=title,
                source_type="web",
                category_id=feed_source.category_id,
                url=article_url,
                raw_content=raw_content,
                metadata=article_meta,
            )

            try:
                await persist_source(
                    session=session,
                    body=body,
                    user_id=feed_source.user_id,
                    content_hash_override=content_hash,
                )
                new_count += 1
            except Exception:
                logger.error(
                    "Failed to persist RSS article: feed=%s title=%s",
                    feed_source.id, title, exc_info=True,
                )

    _mark_fetch_meta(meta, "ok", last_fetch_count=new_count)
    meta["feed_type"] = "collection"
    if resp.headers.get("etag"):
        meta["etag"] = resp.headers["etag"]
    if resp.headers.get("last-modified"):
        meta["last_modified"] = resp.headers["last-modified"]
    feed_source.metadata_ = meta
    await session.commit()

    if new_count:
        try:
            from pkg.services.discovery import generate_discovery_items

            await generate_discovery_items(session, user_id=feed_source.user_id, providers=["rss"], limit=settings.RSS_MAX_ARTICLES_PER_FEED)
        except Exception:
            logger.error("RSS discovery item generation failed for feed=%s", feed_source.id, exc_info=True)

    elapsed = time.monotonic() - start
    logger.info(
        "RSS fetched: source=%s new_articles=%d elapsed=%.1fs",
        feed_source.id, new_count, elapsed,
    )
    return new_count


# ---------------------------------------------------------------------------
# Batch operations
# ---------------------------------------------------------------------------

async def fetch_all_feeds() -> dict[str, int]:
    """Fetch all RSS-enabled web sources. Returns stats dict."""
    stats = {"feeds_checked": 0, "new_articles": 0, "errors": 0}
    sem = asyncio.Semaphore(_FEED_CONCURRENCY)

    async with async_session() as session:
        result = await session.execute(
            select(Source).where(
                Source.source_type == "web",
                text("metadata->>'rss_enabled' = 'true'"),
            )
        )
        feeds = list(result.scalars())

    if not feeds:
        logger.info("No RSS-enabled feeds found")
        return stats

    async def _fetch_one(feed: Source) -> None:
        async with sem:
            async with async_session() as session:
                feed_obj = await session.get(Source, feed.id)
                if not feed_obj:
                    return
                try:
                    count = await fetch_single_feed(feed_obj, session)
                    stats["new_articles"] += count
                except Exception:
                    logger.error("RSS feed error: source=%s", feed.id, exc_info=True)
                    stats["errors"] += 1
                finally:
                    stats["feeds_checked"] += 1

    await asyncio.gather(*[_fetch_one(f) for f in feeds])

    logger.info("RSS fetch_all complete: %s", stats)
    return stats


async def cleanup_old_rss_articles() -> int:
    """Delete RSS articles older than RSS_RETENTION_DAYS. Returns count deleted."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=settings.RSS_RETENTION_DAYS)
    deleted = 0

    async with async_session() as session:
        result = await session.execute(
            select(Source).where(
                Source.ingested_at < cutoff,
                text("metadata->>'feed_source_id' IS NOT NULL"),
            )
        )
        old_articles = list(result.scalars())

        if not old_articles:
            return 0

        storage = get_storage_service()
        for article in old_articles:
            try:
                await session.execute(
                    SourceChunk.__table__.delete().where(SourceChunk.source_id == article.id)
                )
                await session.execute(
                    SourceEmbedding.__table__.delete().where(
                        SourceEmbedding.source_id == article.id
                    )
                )
                if article.file_path and article.file_path.startswith("minio://"):
                    try:
                        await storage.delete_object(article.file_path)
                    except Exception:
                        logger.warning("Failed to delete OSS object: %s", article.file_path)
                await session.delete(article)
                deleted += 1
            except Exception:
                logger.error("Failed to delete old RSS article: %s", article.id, exc_info=True)

        await session.commit()

    logger.info("RSS cleanup: deleted %d articles older than %d days", deleted, settings.RSS_RETENTION_DAYS)
    return deleted
