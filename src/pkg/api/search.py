from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.note import SearchRequest, SearchResult
from pkg.services.cross_cutting.activity import log_activity
from pkg.services.foundation.retriever import RetrieverAgent
from pkg.services.cross_cutting.stats import increment_stats
from pkg.services.foundation.sync_pipeline import sync_notes_from_directory, sync_sources_from_directory

router = APIRouter()


@router.post("/search", response_model=list[SearchResult])
async def search(
    body: SearchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    retriever = RetrieverAgent(session, user_id=user.id)
    results = await retriever.search(
        query=body.query, mode=body.mode, top_k=body.top_k, filters=body.filters
    )
    await log_activity(user.id, "search", {"query": body.query, "mode": body.mode, "results": len(results)})

    # Track search hits per item
    note_ids = [r.id for r in results if r.type == "note"]
    source_ids = [r.id for r in results if r.type in ("source", "source_chunk")]
    if note_ids:
        await increment_stats(note_ids, "note", "search_count")
    if source_ids:
        await increment_stats(source_ids, "source", "search_count")

    return results


@router.post("/sync")
async def sync(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    notes_stats = await sync_notes_from_directory(session, settings.notes_dir, user_id=user.id)
    sources_stats = await sync_sources_from_directory(session, settings.sources_dir, user_id=user.id)
    return {"notes": notes_stats, "sources": sources_stats}
