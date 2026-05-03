import hashlib
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.api.categories import get_default_category_id
from pkg.api.deps import get_current_user
from pkg.api.notes import make_note_id, persist_note, put_note_markdown_oss
from pkg.api.sources import make_source_id, persist_source
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
    RememberRequest,
    SaveDocumentRequest,
    SaveDocumentResponse,
)
from pkg.schemas.note import NoteCreate, NoteRead
from pkg.schemas.source import SourceCreate
from pkg.models.user import User
from pkg.services.storage import get_storage_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/models")
async def list_models(user: User = Depends(get_current_user)):
    """Return available models from all configured LLM providers."""
    from pkg.services.llm import list_all_models

    return await list_all_models()


@router.post("/save-document", response_model=SaveDocumentResponse, status_code=201)
async def save_document(
    body: SaveDocumentRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Save a generated document as MD — creates a Source + Note pair."""
    storage = get_storage_service()
    category_id = body.category_id or await get_default_category_id(session)

    # Derive title
    title = body.title
    if not title and body.document_filename:
        title = Path(body.document_filename).stem.replace("-", " ").replace("_", " ").title()
    if not title:
        title = body.message_content.replace("\n", " ").strip()[:40] or "Untitled Document"

    raw_content = body.message_content

    # Upload markdown as .md file to MinIO
    source_id = make_source_id(title)
    md_object_key = f"exports/{source_id}.md"
    md_storage_uri = await storage.upload_bytes(
        object_key=md_object_key,
        data=raw_content.encode("utf-8"),
        content_type="text/markdown; charset=utf-8",
    )

    source_body = SourceCreate(
        title=title,
        source_type="article",
        category_id=category_id,
        raw_content=raw_content,
        file_path=md_storage_uri,
    )
    source = await persist_source(
        session=session,
        body=source_body.model_copy(update={"id": source_id}),
        user_id=user.id,
        file_path=md_storage_uri,
        raw_content_override=raw_content,
        content_hash_override=hashlib.sha256(raw_content.encode()).hexdigest(),
    )

    # Create Note record linked to the source
    note_body = NoteCreate(
        title=title,
        note_type="concept",
        category_id=category_id,
        content=raw_content,
        source_ids=[source.id],
        status="seed",
        tags=["from-document"],
    )
    note_id = make_note_id(title)
    note_storage_uri = await put_note_markdown_oss(note_id, raw_content)
    note = await persist_note(
        session=session,
        body=note_body.model_copy(update={"id": note_id}),
        user_id=user.id,
        file_path=note_storage_uri,
        content_override=raw_content,
    )

    return SaveDocumentResponse(source_id=source.id, note_id=note.id)


@router.post("/remember", response_model=NoteRead, status_code=201)
async def remember_knowledge(
    body: RememberRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Save assistant response as a temporary note for later daily summarization."""
    title = body.title or body.content.replace("\n", " ").strip()[:40] or "Chat memory"
    category_id = body.category_id or await get_default_category_id(session)

    note_body = NoteCreate(
        title=title,
        note_type="remember",
        category_id=category_id,
        content=body.content,
        status="temporary",
        tags=["auto-remember"],
        domains=["chat-memory"],
    )
    note_id = make_note_id(note_body.title)
    storage_uri = await put_note_markdown_oss(note_id, body.content)
    note = await persist_note(
        session=session,
        body=note_body.model_copy(update={"id": note_id}),
        user_id=user.id,
        file_path=storage_uri,
        content_override=body.content,
    )
    return note


@router.post("/summarize-daily")
async def trigger_daily_summary(user: User = Depends(get_current_user)):
    """Manually trigger the daily temporary notes summarization."""
    from pkg.services.daily_summarizer import summarize_temporary_notes

    note_id = await summarize_temporary_notes()
    if note_id is None:
        return {"status": "skipped", "detail": "No temporary notes to summarize"}
    return {"status": "ok", "note_id": note_id}


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Aggregate dashboard data: counts, 7-day trends, distributions."""
    uid = user.id

    # --- Counts ---
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

    # --- 7-day trends ---
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

    # --- Category distribution ---
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

    # --- Note type distribution ---
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
