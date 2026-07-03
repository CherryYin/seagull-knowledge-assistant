import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.discovery import DiscoveryItem
from pkg.models.user import User
from pkg.schemas.discovery import (
    DiscoveryFeedbackRequest,
    DiscoveryFeedbackResult,
    DiscoveryGenerateRequest,
    DiscoveryGenerateResult,
    DiscoveryWebIngestRequest,
    DiscoveryWebSearchRequest,
    DiscoveryItemList,
    DiscoveryItemRead,
)
from pkg.services.foundation.discovery import apply_discovery_feedback, generate_discovery_items, ingest_web_discovery_results, search_external_web_results

router = APIRouter()


@router.get("", response_model=DiscoveryItemList)
async def list_discovery_items(
    provider: str | None = Query(default=None, pattern=r"^(arxiv|github|rss|web|openalex|crossref|semantic_scholar)$"),
    status: str | None = Query(default="recommended", pattern=r"^(recommended|kept|saved|dismissed)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    filters = [DiscoveryItem.user_id == user.id]
    if provider:
        filters.append(DiscoveryItem.provider == provider)
    if status:
        filters.append(DiscoveryItem.status == status)

    count_stmt = select(func.count()).select_from(DiscoveryItem).where(*filters)
    stmt = select(DiscoveryItem).where(*filters).order_by(DiscoveryItem.score.desc().nullslast(), DiscoveryItem.updated_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    return DiscoveryItemList(items=list(rows.scalars()), total=total)


@router.post("/generate", response_model=DiscoveryGenerateResult)
async def generate_discovery(
    body: DiscoveryGenerateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    created, updated, skipped = await generate_discovery_items(session, user_id=user.id, providers=body.providers, limit=body.limit)
    return DiscoveryGenerateResult(created=created, updated=updated, skipped=skipped)


@router.post("/web-results", response_model=DiscoveryGenerateResult)
async def ingest_web_results(
    body: DiscoveryWebIngestRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    created, updated, skipped = await ingest_web_discovery_results(
        session,
        user_id=user.id,
        query=body.query,
        items=[item.model_dump() for item in body.items],
    )
    return DiscoveryGenerateResult(created=created, updated=updated, skipped=skipped)


@router.post("/web-search", response_model=DiscoveryGenerateResult)
async def search_web_results(
    body: DiscoveryWebSearchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        items = await search_external_web_results(body.query, max_results=body.max_results, user_id=user.id)
        created, updated, skipped = await ingest_web_discovery_results(
            session,
            user_id=user.id,
            query=body.query,
            items=items,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Web search timed out") from exc
    return DiscoveryGenerateResult(created=created, updated=updated, skipped=skipped)


@router.patch("/{item_id}/feedback", response_model=DiscoveryFeedbackResult)
async def update_discovery_feedback(
    item_id: int,
    body: DiscoveryFeedbackRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    item = await session.get(DiscoveryItem, item_id)
    if not item or item.user_id != user.id:
        raise HTTPException(status_code=404, detail="Discovery item not found")
    try:
        source, created = await apply_discovery_feedback(session, item=item, action=body.action, note=body.note)
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return DiscoveryFeedbackResult(item=DiscoveryItemRead.model_validate(item), source=source, created=created)
