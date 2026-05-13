import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.api.deps import get_current_user
from pkg.models.category import Category
from pkg.models.chat_session import ChatSession
from pkg.models.note import Note
from pkg.models.source import Source
from pkg.schemas.knowledge import (
    DashboardCounts,
    DashboardResponse,
    DashboardTrendDay,
    CategoryDistribution,
    NoteTypeDistribution,
    KnowledgeStatsList,
    KnowledgeStatsRead,
)
from pkg.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Aggregate dashboard data: counts, 7-day trends, distributions."""
    uid = user.id

    notes_count = (await session.execute(
        select(func.count()).select_from(Note).where(Note.user_id == uid)
    )).scalar() or 0

    sources_count = (await session.execute(
        select(func.count()).select_from(Source).where(Source.user_id == uid)
    )).scalar() or 0

    chats_count = (await session.execute(
        select(func.count()).select_from(ChatSession).where(ChatSession.user_id == uid)
    )).scalar() or 0

    digest_pending = (await session.execute(
        select(func.count()).select_from(Note).where(
            Note.user_id == uid,
            Note.note_type == "digest",
            Note.status == "pending_review",
        )
    )).scalar() or 0

    counts = DashboardCounts(
        notes=notes_count,
        sources=sources_count,
        chats=chats_count,
        digest_pending=digest_pending,
    )

    seven_days_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)

    notes_by_day = dict((await session.execute(
        select(
            cast(Note.created_at, Date).label("day"),
            func.count().label("cnt"),
        ).where(Note.user_id == uid, Note.created_at >= seven_days_ago)
        .group_by("day")
    )).all())

    sources_by_day = dict((await session.execute(
        select(
            cast(Source.ingested_at, Date).label("day"),
            func.count().label("cnt"),
        ).where(Source.user_id == uid, Source.ingested_at >= seven_days_ago)
        .group_by("day")
    )).all())

    chats_by_day = dict((await session.execute(
        select(
            cast(ChatSession.created_at, Date).label("day"),
            func.count().label("cnt"),
        ).where(ChatSession.user_id == uid, ChatSession.created_at >= seven_days_ago)
        .group_by("day")
    )).all())

    trends: list[DashboardTrendDay] = []
    for i in range(7):
        d = (datetime.now(timezone.utc) - timedelta(days=6 - i)).date()
        trends.append(DashboardTrendDay(
            date=d.isoformat(),
            notes=notes_by_day.get(d, 0),
            sources=sources_by_day.get(d, 0),
            chats=chats_by_day.get(d, 0),
        ))

    cat_notes = dict((await session.execute(
        select(Note.category_id, func.count())
        .where(Note.user_id == uid)
        .group_by(Note.category_id)
    )).all())

    cat_sources = dict((await session.execute(
        select(Source.category_id, func.count())
        .where(Source.user_id == uid)
        .group_by(Source.category_id)
    )).all())

    all_cat_ids = set(cat_notes.keys()) | set(cat_sources.keys())
    cats_map: dict[int, Category] = {}
    if all_cat_ids:
        rows = (await session.execute(
            select(Category).where(Category.id.in_(all_cat_ids))
        )).scalars()
        cats_map = {c.id: c for c in rows}

    category_distribution = [
        CategoryDistribution(
            name=cats_map[cid].name if cid in cats_map else "unknown",
            display_name=cats_map[cid].display_name if cid in cats_map else "Unknown",
            notes=cat_notes.get(cid, 0),
            sources=cat_sources.get(cid, 0),
        )
        for cid in sorted(all_cat_ids)
    ]

    type_rows = (await session.execute(
        select(Note.note_type, func.count())
        .where(Note.user_id == uid)
        .group_by(Note.note_type)
    )).all()
    note_type_distribution = [
        NoteTypeDistribution(type=t, count=c) for t, c in type_rows
    ]

    return DashboardResponse(
        counts=counts,
        trends=trends,
        category_distribution=category_distribution,
        note_type_distribution=note_type_distribution,
    )


@router.get("/stats", response_model=KnowledgeStatsList)
async def get_knowledge_stats(
    sort_by: str = "total_count",
    item_type: str | None = None,
    title: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
):
    """Get knowledge usage statistics ranked by search/retrieval/reference counts."""
    from pkg.services.stats import get_knowledge_rankings

    items, total = await get_knowledge_rankings(
        user_id=user.id,
        sort_by=sort_by,
        item_type=item_type,
        title=title,
        limit=limit,
        offset=offset,
    )
    return KnowledgeStatsList(
        items=[KnowledgeStatsRead(**item) for item in items],
        total=total,
    )
