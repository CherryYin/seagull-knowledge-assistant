import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from sqlalchemy import select

from pkg.db import async_session
from pkg.models.foundation.source import Source


WEB_FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
}

WEB_FETCH_TIMEOUT_SECONDS = 20
WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
BLOCK_TAGS = {"p", "div", "section", "article", "main", "li", "blockquote", "pre", "h1", "h2", "h3", "h4"}
NOISE_CONTAINER_TAGS = {"nav", "header", "footer", "aside"}
NOISE_TEXT_MARKERS = {
    "api reference",
    "search",
    "send feedback",
    "user documentation",
    "all rights reserved",
    "privacy statement",
    "terms of use",
    "cookie settings",
    "cookies statement",
    "index",
    "libraries",
    "next",
    "previous",
}
DOCS_NOISE_LINE_PATTERNS = (
    "transforms-python •",
    "api reference",
    "user documentation",
    "send feedback",
    "© ",
)


class WebPageFetchError(Exception):
    """Raised when a web source URL cannot be fetched or extracted."""


@dataclass(slots=True)
class WebPageFetchResult:
    url: str
    final_url: str
    title: str | None
    text: str
    metadata: dict[str, Any]


def web_refresh_metadata(source: Source) -> dict:
    return dict(source.metadata_ or {})


def is_web_auto_refresh_enabled(source: Source) -> bool:
    return web_refresh_metadata(source).get("auto_refresh") is True


def web_refresh_interval_days(source: Source) -> int:
    value = web_refresh_metadata(source).get("refresh_interval_days")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 7
    return max(parsed, 1)


def is_web_refresh_due(source: Source, *, now: datetime | None = None) -> bool:
    metadata = web_refresh_metadata(source)
    if source.source_type != "web" or not source.url or not is_web_auto_refresh_enabled(source):
        return False
    if metadata.get("feed_source_id") is not None or metadata.get("web_directory") is True or metadata.get("content_source") == "web_directory":
        return False
    now = now or datetime.now(timezone.utc)
    last_checked = metadata.get("last_checked_at") or metadata.get("last_refreshed_at")
    if not last_checked:
        return True
    try:
        last_dt = datetime.fromisoformat(str(last_checked).replace("Z", "+00:00"))
    except ValueError:
        return True
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    return now >= last_dt + timedelta(days=web_refresh_interval_days(source))


class _ReadableTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._title_depth = 0
        self._main_depth = 0
        self._noise_depth = 0
        self._noise_tags: list[str] = []
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.main_text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.lower(): value for key, value in attrs if value}
        if tag in {"script", "style", "noscript", "svg", "canvas"}:
            self._skip_depth += 1
        if tag == "title":
            self._title_depth += 1
        if tag in {"article", "main"}:
            self._main_depth += 1
        role = (attributes.get("role") or "").lower()
        element_id = (attributes.get("id") or "").lower()
        class_name = (attributes.get("class") or "").lower()
        starts_noise = tag in NOISE_CONTAINER_TAGS or role in {"navigation", "banner", "contentinfo", "complementary"}
        if starts_noise:
            self._noise_depth += 1
            self._noise_tags.append(tag)
        elif any(token in f" {class_name} {element_id} " for token in (" sidebar ", " sidenav ", " toc ", " table-of-contents ", " breadcrumb ", " pagination ", " navbar ", " header ", " footer ", " search ")):
            self._noise_depth += 1
            self._noise_tags.append(tag)
        if tag == "br":
            self._append_text("\n")
        elif tag in BLOCK_TAGS:
            self._append_text("\n\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg", "canvas"} and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title" and self._title_depth:
            self._title_depth -= 1
        if tag in {"article", "main"} and self._main_depth:
            self._main_depth -= 1
        if self._noise_tags and self._noise_tags[-1] == tag and self._noise_depth:
            self._noise_tags.pop()
            self._noise_depth -= 1
        if tag in BLOCK_TAGS:
            self._append_text("\n\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = data.strip()
        if not text:
            return
        if self._title_depth:
            self.title_parts.append(text)
        self._append_text(text)

    def _append_text(self, text: str) -> None:
        if self._noise_depth:
            return
        self.text_parts.append(text)
        if self._main_depth:
            self.main_text_parts.append(text)


class _SemanticMarkdownParser(HTMLParser):
    def __init__(self, *, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url
        self._skip_depth = 0
        self._main_depth = 0
        self._noise_depth = 0
        self._noise_tags: list[str] = []
        self._pending_space = False
        self._link_stack: list[str | None] = []
        self.text_parts: list[str] = []
        self.main_text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.lower(): value for key, value in attrs if value}
        if tag in {"script", "style", "noscript", "svg", "canvas"}:
            self._skip_depth += 1
        if tag in {"article", "main"}:
            self._main_depth += 1
        role = (attributes.get("role") or "").lower()
        element_id = (attributes.get("id") or "").lower()
        class_name = (attributes.get("class") or "").lower()
        starts_noise = tag in NOISE_CONTAINER_TAGS or role in {"navigation", "banner", "contentinfo", "complementary"}
        if starts_noise:
            self._noise_depth += 1
            self._noise_tags.append(tag)
        elif any(token in f" {class_name} {element_id} " for token in (" sidebar ", " sidenav ", " toc ", " table-of-contents ", " breadcrumb ", " pagination ", " navbar ", " header ", " footer ", " search ")):
            self._noise_depth += 1
            self._noise_tags.append(tag)

        if self._skip_depth or self._noise_depth:
            if tag == "a":
                self._link_stack.append(None)
            return
        if tag in {"h1", "h2", "h3", "h4"}:
            self._append_raw(f"\n\n{'#' * int(tag[1])} ")
        elif tag == "li":
            self._append_raw("\n\n- ")
        elif tag == "br":
            self._append_raw("\n")
        elif tag in {"p", "div", "section", "article", "main", "blockquote", "pre"}:
            self._append_raw("\n\n")
        elif tag == "a":
            href = attributes.get("href")
            resolved = urljoin(self.base_url, href) if href else None
            if resolved and urlparse(resolved).scheme in {"http", "https", "mailto"}:
                self._append_raw("[")
                self._link_stack.append(resolved)
            else:
                self._link_stack.append(None)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            href = self._link_stack.pop() if self._link_stack else None
            if href and not self._skip_depth and not self._noise_depth:
                self._append_raw(f"]({href})")
        elif not self._skip_depth and not self._noise_depth and tag in BLOCK_TAGS:
            self._append_raw("\n\n")

        if tag in {"script", "style", "noscript", "svg", "canvas"} and self._skip_depth:
            self._skip_depth -= 1
        if tag in {"article", "main"} and self._main_depth:
            self._main_depth -= 1
        if self._noise_tags and self._noise_tags[-1] == tag and self._noise_depth:
            self._noise_tags.pop()
            self._noise_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth or self._noise_depth:
            return
        text = " ".join(data.split())
        if not text:
            return
        if data[:1].isspace():
            self._pending_space = True
        self._append_text(text)
        self._pending_space = data[-1:].isspace()

    def _buffers(self) -> list[list[str]]:
        buffers = [self.text_parts]
        if self._main_depth:
            buffers.append(self.main_text_parts)
        return buffers

    def _append_text(self, text: str) -> None:
        for parts in self._buffers():
            previous = parts[-1][-1:] if parts and parts[-1] else ""
            if (self._pending_space or (previous and previous not in "\n [")) and text[:1] not in ".,;:!?)]}":
                parts.append(" ")
            parts.append(text)
        self._pending_space = False

    def _append_raw(self, value: str) -> None:
        for parts in self._buffers():
            if self._pending_space and value == "[":
                parts.append(" ")
            parts.append(value)
        self._pending_space = False


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.values: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "meta":
            return
        attributes = {key.lower(): value for key, value in attrs if value}
        key = attributes.get("property") or attributes.get("name") or attributes.get("itemprop")
        content = attributes.get("content")
        if key and content:
            self.values[key.lower()] = content.strip()


def _format_readable_text(text: str) -> str:
    paragraphs: list[str] = []
    current: list[str] = []
    for raw_line in text.splitlines():
        line = " ".join(raw_line.split())
        if not line:
            if current:
                paragraphs.append(" ".join(current).strip())
                current = []
            continue
        current.append(line)
    if current:
        paragraphs.append(" ".join(current).strip())

    return "\n\n".join(paragraph for paragraph in paragraphs if paragraph).strip()


def _extract_semantic_markdown(html: str, *, url: str) -> str | None:
    parser = _SemanticMarkdownParser(base_url=url)
    parser.feed(html)
    parts = parser.main_text_parts if parser.main_text_parts else parser.text_parts
    text = "".join(parts)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\[\]\((?:https?|mailto):[^)]+\)", "", text)
    text = re.sub(r"(?m)^#{1,4}\s*$", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text or None


def _prefer_semantic_markdown(extracted: str, semantic: str | None) -> str:
    if not semantic:
        return extracted
    extracted_headings = len(re.findall(r"(?m)^#{1,4}\s+", extracted))
    semantic_headings = len(re.findall(r"(?m)^#{1,4}\s+", semantic))
    if semantic_headings <= extracted_headings:
        return extracted

    length_ratio = len(semantic) / max(len(extracted), 1)
    if not 0.65 <= length_ratio <= 1.5:
        return extracted

    extracted_words = set(re.findall(r"[\w'-]+", extracted.lower()))
    semantic_words = set(re.findall(r"[\w'-]+", semantic.lower()))
    if extracted_words and len(extracted_words & semantic_words) / len(extracted_words) < 0.8:
        return extracted
    return semantic


def _strip_common_page_chrome(text: str) -> str:
    start_markers = [
        "Introducing dynamic workflows in Claude Code",
        "Today we're introducing",
        "Today we’re introducing",
    ]
    end_markers = [
        "FAQ",
        "Related posts",
        "Explore more product news",
        "Transform how your organization operates",
        "Get the developer newsletter",
    ]

    for marker in start_markers:
        index = text.find(marker)
        if index >= 0:
            text = text[index:]
            break
    for marker in end_markers:
        index = text.find(marker)
        if index > 0:
            text = text[:index]
            break

    lines = text.strip().splitlines()
    while lines and not lines[-1].strip("# "):
        lines.pop()
    return "\n".join(lines).strip()


def _strip_docs_page_chrome(text: str) -> str:
    paragraphs = [paragraph.strip() for paragraph in text.split("\n\n") if paragraph.strip()]
    cleaned: list[str] = []

    for paragraph in paragraphs:
        normalized = " ".join(paragraph.lower().split())
        if normalized in NOISE_TEXT_MARKERS:
            continue
        if any(normalized.startswith(pattern) for pattern in DOCS_NOISE_LINE_PATTERNS):
            continue
        if normalized.count(" • ") >= 2:
            continue
        if len(paragraph.split()) <= 3 and normalized in {"index", "libraries", "rest api", "python", "overview", "exceptions", "functions", "classes"}:
            continue
        if paragraph.count(" AB XY") >= 2:
            continue
        if normalized.startswith("copyright ") or normalized.startswith("© "):
            continue
        cleaned.append(paragraph)

    return "\n\n".join(cleaned).strip()


def _validate_web_url(url: str) -> str:
    normalized = url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WebPageFetchError("URL must be a valid http(s) address")
    return normalized


def _extract_text(html: str, *, url: str) -> str | None:
    semantic = _extract_semantic_markdown(html, url=url)
    try:
        import trafilatura

        text = trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=True,
            favor_precision=True,
            output_format="markdown",
            include_formatting=True,
            include_links=True,
        )
        if text and text.strip():
            extracted = _strip_docs_page_chrome(_strip_common_page_chrome(text)).strip()
            structured = _strip_docs_page_chrome(_strip_common_page_chrome(semantic)).strip() if semantic else None
            return _prefer_semantic_markdown(extracted, structured)

        text = trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
            output_format="markdown",
            include_formatting=True,
            include_links=True,
        )
        if text and text.strip():
            extracted = _strip_docs_page_chrome(_strip_common_page_chrome(text)).strip()
            structured = _strip_docs_page_chrome(_strip_common_page_chrome(semantic)).strip() if semantic else None
            return _prefer_semantic_markdown(extracted, structured)
    except ImportError:
        pass

    if semantic:
        return _strip_docs_page_chrome(_strip_common_page_chrome(semantic)).strip()

    parser = _ReadableTextParser()
    parser.feed(html)
    parts = parser.main_text_parts if parser.main_text_parts else parser.text_parts
    text = _format_readable_text(_strip_docs_page_chrome(_strip_common_page_chrome("\n".join(parts))))
    if text:
        return text
    return None


def _extract_title(html: str, *, url: str) -> str | None:
    try:
        import trafilatura

        metadata = trafilatura.extract_metadata(html, default_url=url)
        title = getattr(metadata, "title", None) if metadata else None
        if isinstance(title, str) and title.strip():
            return title.strip()
    except ImportError:
        pass

    parser = _ReadableTextParser()
    parser.feed(html)
    title = " ".join(parser.title_parts).strip()
    if title:
        return title
    return None


def _extract_updated_at(html: str, headers: httpx.Headers) -> str | None:
    parser = _MetadataParser()
    parser.feed(html)
    for key in (
        "article:modified_time",
        "og:updated_time",
        "date.modified",
        "dateupdated",
        "lastmod",
        "modified_time",
    ):
        value = parser.values.get(key)
        if value:
            return value
    return headers.get("last-modified")


async def fetch_web_page(url: str) -> WebPageFetchResult:
    normalized_url = _validate_web_url(url)

    try:
        async with httpx.AsyncClient(
            timeout=WEB_FETCH_TIMEOUT_SECONDS,
            headers=WEB_FETCH_HEADERS,
            follow_redirects=True,
        ) as client:
            response = await client.get(normalized_url)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        raise WebPageFetchError(f"Web page returned HTTP {status}") from exc
    except httpx.HTTPError as exc:
        raise WebPageFetchError(f"Web page request failed: {exc}") from exc

    content_type = response.headers.get("content-type", "")
    lower_content_type = content_type.lower()
    if content_type and not any(
        kind in lower_content_type for kind in ("text/html", "application/xhtml", "text/plain")
    ):
        raise WebPageFetchError(f"Unsupported content type: {content_type}")

    content = response.content[: WEB_FETCH_MAX_BYTES + 1]
    if len(content) > WEB_FETCH_MAX_BYTES:
        raise WebPageFetchError("Web page is too large to import")

    html = response.text
    final_url = str(response.url)
    text = _extract_text(html, url=final_url)
    if not text:
        stripped = html.strip()
        if content_type.lower().startswith("text/plain") and stripped:
            text = stripped
        else:
            raise WebPageFetchError("Could not extract readable text from the web page")

    metadata = {
        "web_fetch_status": "fetched",
        "web_fetch_url": normalized_url,
        "web_fetch_final_url": final_url,
        "web_fetch_content_type": content_type,
        "web_fetch_status_code": response.status_code,
        "web_fetch_fetched_at": datetime.now(timezone.utc).isoformat(),
        "web_fetch_extractor": "trafilatura",
        "web_fetch_content_format": "markdown",
        "web_fetch_preserves_links": True,
    }
    updated_at = _extract_updated_at(html, response.headers)
    if updated_at:
        metadata["web_fetch_updated_at"] = updated_at

    return WebPageFetchResult(
        url=normalized_url,
        final_url=final_url,
        title=_extract_title(html, url=final_url),
        text=text,
        metadata=metadata,
    )


async def run_web_refresh_step() -> dict:
    from pkg.services.foundation.rss_fetcher import _update_source_content

    now = datetime.now(timezone.utc)
    stats = {
        "sources_considered": 0,
        "sources_due": 0,
        "sources_checked": 0,
        "sources_refreshed": 0,
        "sources_unchanged": 0,
        "errors": 0,
        "reason": None,
    }

    async with async_session() as session:
        rows = await session.execute(select(Source).where(Source.source_type == "web").order_by(Source.ingested_at.desc()))
        sources = list(rows.scalars())

    due_sources = [source for source in sources if is_web_refresh_due(source, now=now)]
    stats["sources_considered"] = len(sources)
    stats["sources_due"] = len(due_sources)
    if not due_sources:
        stats["reason"] = "no_due_web_sources"
        return stats

    async with async_session() as session:
        for source in due_sources:
            source_obj = await session.get(Source, source.id)
            if not source_obj or not source_obj.url:
                continue
            metadata = web_refresh_metadata(source_obj)
            try:
                page = await fetch_web_page(source_obj.url)
                stats["sources_checked"] += 1
                metadata["last_checked_at"] = now.isoformat()
                new_hash = hashlib.sha256(page.text.encode()).hexdigest()
                if source_obj.content_hash == new_hash:
                    source_obj.metadata_ = metadata
                    await session.commit()
                    stats["sources_unchanged"] += 1
                    continue

                source_obj.title = page.title or source_obj.title
                source_obj.url = page.final_url
                metadata.update(page.metadata)
                metadata["last_refreshed_at"] = now.isoformat()
                metadata["auto_refresh"] = metadata.get("auto_refresh") is True
                source_obj.metadata_ = metadata
                await _update_source_content(source_obj, page.text, session)
                await session.commit()
                stats["sources_refreshed"] += 1
            except Exception:
                stats["errors"] += 1
                await session.rollback()

    if stats["sources_checked"] > 0 and stats["sources_refreshed"] == 0 and stats["errors"] == 0:
        stats["reason"] = "no_web_content_changes"
    return stats
