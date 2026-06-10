from datetime import datetime

import httpx

from pkg.config import settings
from pkg.schemas.connector import ExternalPaper


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _headers() -> dict[str, str]:
    return {"User-Agent": "personal-knowledge-graph/0.1"}


def _normalize_work(payload: dict) -> ExternalPaper:
    locations = payload.get("locations") or []
    best_oa_location = payload.get("best_oa_location") or {}
    primary_location = payload.get("primary_location") or {}
    ids = payload.get("ids") or {}
    authorships = payload.get("authorships") or []
    concepts = payload.get("concepts") or []
    pdf_url = None
    for location in [best_oa_location, primary_location, *locations]:
        pdf_url = (location.get("pdf_url") if isinstance(location, dict) else None) or pdf_url
        if pdf_url:
            break
    doi = payload.get("doi") or ids.get("doi")
    if isinstance(doi, str):
        doi = doi.removeprefix("https://doi.org/")
    arxiv_id = None
    if isinstance(ids.get("arxiv"), str):
        arxiv_id = ids["arxiv"].rstrip("/").split("/")[-1]
    return ExternalPaper(
        provider="openalex",
        provider_id=str(payload.get("id") or ""),
        title=payload.get("display_name") or "",
        abstract=None,
        authors=[authorship.get("author", {}).get("display_name") for authorship in authorships if authorship.get("author", {}).get("display_name")],
        published_at=_parse_datetime(payload.get("publication_date")),
        updated_at=None,
        url=payload.get("primary_location", {}).get("landing_page_url") or payload.get("id"),
        pdf_url=pdf_url,
        doi=doi,
        arxiv_id=arxiv_id,
        fields_of_study=[concept.get("display_name") for concept in concepts[:5] if concept.get("display_name")],
        citation_count=payload.get("cited_by_count"),
        reference_count=None,
        venue=(primary_location.get("source") or {}).get("display_name") if isinstance(primary_location, dict) else None,
        year=payload.get("publication_year"),
        keywords=[],
        metadata={"ids": ids},
    )


async def search_openalex(*, query: str, limit: int = 10, from_year: int | None = None) -> list[ExternalPaper]:
    params = {"search": query, "per-page": limit}
    if settings.OPENALEX_API_KEY:
        params["api_key"] = settings.OPENALEX_API_KEY
    if from_year is not None:
        params["filter"] = f"from_publication_date:{from_year}-01-01"
    async with httpx.AsyncClient(timeout=20, headers=_headers()) as client:
        response = await client.get(f"{settings.OPENALEX_API_URL.rstrip('/')}/works", params=params)
        response.raise_for_status()
    payload = response.json() or {}
    return [_normalize_work(item) for item in payload.get("results", [])]
