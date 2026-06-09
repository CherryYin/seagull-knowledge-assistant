from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import httpx


WEB_FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
}

WEB_FETCH_TIMEOUT_SECONDS = 20
WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
BLOCK_TAGS = {"p", "div", "section", "article", "main", "li", "blockquote", "pre", "h1", "h2", "h3", "h4"}


class WebPageFetchError(Exception):
    """Raised when a web source URL cannot be fetched or extracted."""


@dataclass(slots=True)
class WebPageFetchResult:
    url: str
    final_url: str
    title: str | None
    text: str
    metadata: dict[str, Any]


class _ReadableTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._title_depth = 0
        self._main_depth = 0
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.main_text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg", "canvas"}:
            self._skip_depth += 1
        if tag == "title":
            self._title_depth += 1
        if tag in {"article", "main"}:
            self._main_depth += 1
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
        self.text_parts.append(text)
        if self._main_depth:
            self.main_text_parts.append(text)


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
    return text.strip()


def _validate_web_url(url: str) -> str:
    normalized = url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WebPageFetchError("URL must be a valid http(s) address")
    return normalized


def _extract_text(html: str, *, url: str) -> str | None:
    try:
        import trafilatura

        text = trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=True,
            favor_precision=True,
            output_format="txt",
        )
        if text and text.strip():
            return _format_readable_text(text)

        text = trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
            output_format="txt",
        )
        if text and text.strip():
            return _format_readable_text(text)
    except ImportError:
        pass

    parser = _ReadableTextParser()
    parser.feed(html)
    parts = parser.main_text_parts if parser.main_text_parts else parser.text_parts
    text = _format_readable_text(_strip_common_page_chrome("\n".join(parts)))
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
