from datetime import datetime

import httpx

from pkg.schemas.connector import ExternalPaper


def _date_parts_to_datetime(parts: list[int] | None) -> datetime | None:
    if not parts:
        return None
    year = parts[0]
    month = parts[1] if len(parts) > 1 else 1
    day = parts[2] if len(parts) > 2 else 1
    try:
        return datetime(year, month, day)
    except ValueError:
        return None


def _normalize_item(payload: dict) -> ExternalPaper:
    title = (payload.get("title") or [""])[0]
    authors = []
    for author in payload.get("author") or []:
        name = " ".join(part for part in [author.get("given"), author.get("family")] if part)
        if name:
            authors.append(name)
    published_parts = (((payload.get("published-print") or {}).get("date-parts") or [[None]])[0])
    doi = payload.get("DOI")
    return ExternalPaper(
        provider="crossref",
        provider_id=doi or payload.get("URL") or title,
        title=title,
        abstract=payload.get("abstract"),
        authors=authors,
        published_at=_date_parts_to_datetime(published_parts),
        updated_at=None,
        url=payload.get("URL"),
        pdf_url=None,
        doi=doi,
        arxiv_id=None,
        fields_of_study=[],
        citation_count=payload.get("is-referenced-by-count"),
        reference_count=payload.get("references-count"),
        venue=(payload.get("container-title") or [None])[0],
        year=published_parts[0] if published_parts and published_parts[0] else None,
        keywords=[],
        metadata=None,
    )


async def search_crossref(*, query: str, limit: int = 10) -> list[ExternalPaper]:
    params = {"query": query, "rows": limit}
    headers = {"User-Agent": "personal-knowledge-graph/0.1 (mailto:devnull@example.com)"}
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        response = await client.get("https://api.crossref.org/works", params=params)
        response.raise_for_status()
    payload = response.json() or {}
    return [_normalize_item(item) for item in ((payload.get("message") or {}).get("items") or [])]
