from datetime import datetime, timezone
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.paper_discovery import PaperDiscoveryProfile, PaperDiscoveryRun
from pkg.schemas.connector import ExternalPaper
from pkg.schemas.paper_discovery import PaperQueryBundle
from pkg.services.foundation.discovery import _load_profile, _upsert_discovery_item
from pkg.services.paper_providers.crossref import search_crossref
from pkg.services.paper_providers.openalex import search_openalex
from pkg.services.foundation.paper_query_builder import build_paper_query_bundle
from pkg.services.foundation.paper_discovery_seen import get_seen_item, mark_seen_item
from pkg.services.foundation.paper_trends import find_paper_trends


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def get_paper_discovery_profile(session: AsyncSession, *, user_id: str, profile_id: int) -> PaperDiscoveryProfile | None:
    row = await session.execute(
        select(PaperDiscoveryProfile).where(
            PaperDiscoveryProfile.id == profile_id,
            PaperDiscoveryProfile.user_id == user_id,
        )
    )
    return row.scalar_one_or_none()


async def preview_profile_queries(session: AsyncSession, *, user_id: str, profile_id: int) -> PaperQueryBundle:
    profile = await get_paper_discovery_profile(session, user_id=user_id, profile_id=profile_id)
    if not profile:
        raise ValueError("Paper discovery profile not found")
    return build_paper_query_bundle(profile)


async def list_profile_candidates(
    session: AsyncSession,
    *,
    user_id: str,
    profile_id: int,
    limit: int = 50,
) -> list[DiscoveryItem]:
    profile = await get_paper_discovery_profile(session, user_id=user_id, profile_id=profile_id)
    if not profile:
        raise ValueError("Paper discovery profile not found")
    row = await session.execute(
        select(DiscoveryItem)
        .where(DiscoveryItem.user_id == user_id)
        .where(DiscoveryItem.payload["origin"].astext == "paper_discovery")
        .where(DiscoveryItem.payload["paper_profile_id"].astext == str(profile_id))
        .order_by(DiscoveryItem.updated_at.desc())
        .limit(limit)
    )
    return list(row.scalars())


def _paper_item_key(paper: ExternalPaper) -> str:
    if paper.arxiv_id:
        return f"{paper.provider}:arxiv:{paper.arxiv_id.lower()}"
    if paper.doi:
        return f"{paper.provider}:doi:{paper.doi.lower()}"
    return f"{paper.provider}:paper:{paper.provider_id}"


def _paper_payload(paper: ExternalPaper, *, query_spec: dict, run_id: int, profile_id: int) -> dict:
    return {
        "paper_provider": paper.provider,
        "paper_provider_id": paper.provider_id,
        "paper_external_ids": paper.metadata.get("external_ids") if paper.metadata else {},
        "title": paper.title,
        "abstract": paper.abstract,
        "authors": paper.authors,
        "url": paper.url,
        "pdf_url": paper.pdf_url,
        "doi": paper.doi,
        "arxiv_id": paper.arxiv_id,
        "fields_of_study": paper.fields_of_study,
        "citation_count": paper.citation_count,
        "reference_count": paper.reference_count,
        "venue": paper.venue,
        "year": paper.year,
        "paper_query": query_spec.get("query"),
        "paper_query_label": query_spec.get("label"),
        "paper_query_rationale": query_spec.get("rationale"),
        "paper_run_id": run_id,
        "paper_profile_id": profile_id,
        "origin": "paper_discovery",
    }


def _paper_candidate(paper: ExternalPaper, *, query_spec: dict, profile_id: int, run_id: int) -> dict:
    return {
        "source": "paper_discovery_query",
        "provider": paper.provider,
        "item_key": _paper_item_key(paper),
        "title": paper.title,
        "payload": _paper_payload(paper, query_spec=query_spec, run_id=run_id, profile_id=profile_id),
        "base_score": 0,
        "source_id": None,
    }


logger = logging.getLogger(__name__)


async def _search_papers_with_fallback(*, query: str, limit: int, window_days: int) -> list[ExternalPaper]:
    from_year = max(1900, datetime.now(timezone.utc).year - max(0, window_days // 365))
    try:
        papers = await search_openalex(query=query, limit=limit, from_year=from_year)
        if papers:
            return papers
    except (RuntimeError, ValueError, TimeoutError) as exc:
        logger.warning("OpenAlex search failed for query %s: %s", query, exc)
    return await search_crossref(query=query, limit=limit)


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


async def execute_profile_run(
    session: AsyncSession,
    *,
    user_id: str,
    profile_id: int,
    mode: str | None = None,
    limit: int | None = None,
    commit: bool = True,
) -> tuple[PaperDiscoveryRun, list[DiscoveryItem], int, int]:
    profile = await get_paper_discovery_profile(session, user_id=user_id, profile_id=profile_id)
    if not profile:
        raise ValueError("Paper discovery profile not found")

    bundle = build_paper_query_bundle(profile)
    run = PaperDiscoveryRun(
        profile_id=profile.id,
        user_id=user_id,
        mode=mode or profile.mode,
        status="running",
        query_bundle=bundle.model_dump(),
        stats=None,
    )
    session.add(run)
    await session.flush()

    effective_mode = mode or profile.mode
    queries = bundle.primary_queries + bundle.expanded_queries
    search_limit = limit or profile.max_results
    candidates: list[dict] = []
    if effective_mode in {"query", "hybrid"}:
        for query_spec in queries:
            papers = await _search_papers_with_fallback(
                query=query_spec.query,
                limit=search_limit,
                window_days=profile.discovery_window_days,
            )
            for paper in papers:
                candidates.append(_paper_candidate(paper, query_spec=query_spec.model_dump(), profile_id=profile.id, run_id=run.id))

    trend_snapshots = []
    if effective_mode in {"trend", "hybrid"}:
        trend_snapshots = await find_paper_trends(session, profile=profile, commit=False)

    deduped_candidates = _dedupe_candidates(candidates)
    scoring_profile = await _load_profile(session, user_id)
    created = 0
    updated = 0
    items: list[DiscoveryItem] = []
    unseen_candidates: list[dict] = []
    seen_filtered = 0
    for candidate in deduped_candidates:
        seen = await get_seen_item(
            session,
            user_id=user_id,
            profile_id=profile.id,
            provider=candidate["provider"],
            item_key=candidate["item_key"],
        )
        if seen:
            seen_filtered += 1
            continue
        unseen_candidates.append(candidate)

    for candidate in unseen_candidates:
        item, was_created = await _upsert_discovery_item(session, user_id=user_id, candidate=candidate, profile=scoring_profile)
        items.append(item)
        payload = candidate.get("payload") or {}
        await mark_seen_item(
            session,
            user_id=user_id,
            profile_id=profile.id,
            provider=candidate["provider"],
            item_key=candidate["item_key"],
            paper_provider_id=payload.get("paper_provider_id"),
            arxiv_id=payload.get("arxiv_id"),
            doi=payload.get("doi"),
            first_seen_run_id=run.id,
        )
        if was_created:
            created += 1
        else:
            updated += 1

    run.status = "completed"
    run.stats = {
        "mode": effective_mode,
        "queries_executed": len(queries),
        "candidates_found": len(candidates),
        "candidates_deduped": len(deduped_candidates),
        "seen_filtered": seen_filtered,
        "new_candidates": len(unseen_candidates),
        "trend_snapshots": len(trend_snapshots),
        "created": created,
        "updated": updated,
    }
    run.finished_at = _utc_now_naive()
    profile.last_run_at = run.finished_at

    if commit:
        await session.commit()
    return run, items, created, updated
