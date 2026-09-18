import asyncio
import logging
import random
import time

import httpx

from pkg.config import settings
from pkg.schemas.connector import ExternalPaper

logger = logging.getLogger(__name__)

_request_lock = asyncio.Lock()
_last_request_at = 0.0


class SemanticScholarRateLimitError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    headers = {"User-Agent": settings.SEMANTIC_SCHOLAR_USER_AGENT}
    if settings.SEMANTIC_SCHOLAR_API_KEY:
        headers["x-api-key"] = settings.SEMANTIC_SCHOLAR_API_KEY
    return headers


async def _throttle_request() -> None:
    global _last_request_at
    min_interval = max(float(settings.SEMANTIC_SCHOLAR_MIN_REQUEST_INTERVAL_SECONDS), 0.0)
    async with _request_lock:
        now = time.monotonic()
        delay = min_interval - (now - _last_request_at)
        if delay > 0:
            await asyncio.sleep(delay)
        _last_request_at = time.monotonic()


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return min(max(float(retry_after), 0.0), float(settings.SEMANTIC_SCHOLAR_RETRY_MAX_DELAY_SECONDS))
        except ValueError:
            pass
    base_delay = max(float(settings.SEMANTIC_SCHOLAR_RETRY_INITIAL_DELAY_SECONDS), 0.0)
    max_delay = max(float(settings.SEMANTIC_SCHOLAR_RETRY_MAX_DELAY_SECONDS), base_delay)
    delay = min(base_delay * (2 ** attempt), max_delay)
    jitter = random.uniform(0, min(1.0, delay * 0.1)) if delay > 0 else 0.0
    return delay + jitter


def _normalize_paper(payload: dict) -> ExternalPaper:
    external_ids = payload.get("externalIds") or {}
    authors = payload.get("authors") or []
    fields = payload.get("fieldsOfStudy") or []
    open_access_pdf = payload.get("openAccessPdf") or {}
    return ExternalPaper(
        provider="semantic_scholar",
        provider_id=str(payload.get("paperId") or ""),
        title=payload.get("title") or "",
        abstract=payload.get("abstract"),
        authors=[author.get("name", "") for author in authors if author.get("name")],
        published_at=_parse_datetime(payload.get("publicationDate")),
        updated_at=None,
        url=payload.get("url"),
        pdf_url=open_access_pdf.get("url"),
        doi=external_ids.get("DOI"),
        arxiv_id=external_ids.get("ArXiv"),
        fields_of_study=[field for field in fields if field],
        citation_count=payload.get("citationCount"),
        reference_count=payload.get("referenceCount"),
        venue=payload.get("venue"),
        year=payload.get("year"),
        keywords=[],
        metadata={"external_ids": external_ids},
    )


def _parse_datetime(value: str | None):
    if not value:
        return None
    try:
        from datetime import datetime

        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _request_json(path: str, *, params: dict | None = None, retries: int = 2) -> dict:
    base_url = settings.SEMANTIC_SCHOLAR_API_URL.rstrip("/")
    async with httpx.AsyncClient(timeout=settings.SEMANTIC_SCHOLAR_TIMEOUT_SECONDS, headers=_headers()) as client:
        for attempt in range(retries + 1):
            await _throttle_request()
            response = await client.get(f"{base_url}/{path.lstrip('/')}", params=params)
            if response.status_code != 429:
                response.raise_for_status()
                return response.json()
            delay = _retry_delay(response, attempt)
            logger.warning(
                "Semantic Scholar returned 429",
                extra={"attempt": attempt + 1, "retries": retries, "delay_seconds": delay, "path": path},
            )
            if attempt >= retries:
                raise SemanticScholarRateLimitError("Semantic Scholar rate limit exceeded; please retry later.")
            await asyncio.sleep(delay)
    return {}


async def search_semantic_scholar(*, query: str, limit: int = 10, fields: list[str] | None = None, year: str | None = None) -> list[ExternalPaper]:
    request_fields = fields or [
        "paperId",
        "title",
        "abstract",
        "authors",
        "publicationDate",
        "year",
        "url",
        "venue",
        "citationCount",
        "referenceCount",
        "fieldsOfStudy",
        "externalIds",
        "openAccessPdf",
    ]
    params = {"query": query, "limit": limit, "fields": ",".join(request_fields)}
    if year:
        params["year"] = year
    payload = await _request_json("paper/search", params=params)
    return [_normalize_paper(item) for item in payload.get("data", [])]


async def lookup_semantic_scholar_paper(provider_id: str, *, fields: list[str] | None = None) -> ExternalPaper | None:
    request_fields = fields or [
        "paperId",
        "title",
        "abstract",
        "authors",
        "publicationDate",
        "year",
        "url",
        "venue",
        "citationCount",
        "referenceCount",
        "fieldsOfStudy",
        "externalIds",
        "openAccessPdf",
    ]
    payload = await _request_json(f"paper/{provider_id}", params={"fields": ",".join(request_fields)})
    if not payload:
        return None
    return _normalize_paper(payload)


async def lookup_semantic_scholar_by_arxiv_id(arxiv_id: str, *, fields: list[str] | None = None) -> ExternalPaper | None:
    return await lookup_semantic_scholar_paper(f"ARXIV:{arxiv_id}", fields=fields)


async def recommend_semantic_scholar_papers(*, seed_ids: list[str], limit: int = 10, fields: list[str] | None = None) -> list[ExternalPaper]:
    request_fields = fields or [
        "paperId",
        "title",
        "abstract",
        "authors",
        "publicationDate",
        "year",
        "url",
        "venue",
        "citationCount",
        "referenceCount",
        "fieldsOfStudy",
        "externalIds",
        "openAccessPdf",
    ]
    payload = await _request_json(
        "recommendations/v1/papers/",
        params={"fields": ",".join(request_fields), "limit": limit, "seedPaperIds": ",".join(seed_ids)},
    )
    return [_normalize_paper(item) for item in payload.get("recommendedPapers", [])]
