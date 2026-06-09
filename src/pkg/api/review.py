from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.foundation.review import ReviewSuggestion
from pkg.models.user import User
from pkg.schemas.review import (
    ReviewSuggestionGenerateRequest,
    ReviewSuggestionGenerateResult,
    ReviewSuggestionList,
    ReviewSuggestionRead,
    ReviewSuggestionUpdate,
)
from pkg.services.foundation.review_suggestions import apply_review_suggestion, ensure_review_suggestions

router = APIRouter()


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@router.get("/suggestions", response_model=ReviewSuggestionList)
async def list_review_suggestions(
    suggestion_type: str | None = Query(default=None, pattern=r"^(low_confidence_fact|profile_update)$"),
    status: str | None = Query(default="pending", pattern=r"^(pending|accepted|rejected|dismissed|applied)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    filters = [ReviewSuggestion.user_id == user.id]
    if suggestion_type:
        filters.append(ReviewSuggestion.suggestion_type == suggestion_type)
    if status:
        filters.append(ReviewSuggestion.status == status)

    count_stmt = select(func.count()).select_from(ReviewSuggestion).where(*filters)
    stmt = select(ReviewSuggestion).where(*filters).order_by(ReviewSuggestion.created_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    return ReviewSuggestionList(items=list(rows.scalars()), total=total)


@router.post("/suggestions/generate", response_model=ReviewSuggestionGenerateResult)
async def generate_review_suggestions(
    body: ReviewSuggestionGenerateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    created, skipped = await ensure_review_suggestions(
        session,
        user_id=user.id,
        include_low_confidence_facts=body.include_low_confidence_facts,
        include_profile_suggestions=body.include_profile_suggestions,
        limit=body.limit,
    )
    return ReviewSuggestionGenerateResult(created=created, skipped=skipped)


@router.patch("/suggestions/{suggestion_id}", response_model=ReviewSuggestionRead)
async def update_review_suggestion(
    suggestion_id: int,
    body: ReviewSuggestionUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    suggestion = await session.get(ReviewSuggestion, suggestion_id)
    if not suggestion or suggestion.user_id != user.id:
        raise HTTPException(status_code=404, detail="Review suggestion not found")

    now = _utc_now_naive()
    suggestion.status = body.status
    suggestion.reviewer_note = body.reviewer_note
    if suggestion.status in {"accepted", "rejected", "dismissed", "applied"}:
        suggestion.reviewed_at = now
    if suggestion.status == "applied":
        await apply_review_suggestion(session, suggestion)
        suggestion.applied_at = now

    await session.commit()
    await session.refresh(suggestion)
    return suggestion
