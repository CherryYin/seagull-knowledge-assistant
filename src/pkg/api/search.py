from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import get_session
from pkg.schemas.note import SearchRequest, SearchResult
from pkg.services.retriever import RetrieverAgent
from pkg.services.sync_pipeline import sync_notes_from_directory, sync_sources_from_directory

router = APIRouter()


@router.post("/search", response_model=list[SearchResult])
async def search(body: SearchRequest, session: AsyncSession = Depends(get_session)):
    retriever = RetrieverAgent(session)
    return await retriever.search(
        query=body.query, mode=body.mode, top_k=body.top_k, filters=body.filters
    )


@router.post("/sync")
async def sync(session: AsyncSession = Depends(get_session)):
    notes_stats = await sync_notes_from_directory(session, settings.notes_dir)
    sources_stats = await sync_sources_from_directory(session, settings.sources_dir)
    return {"notes": notes_stats, "sources": sources_stats}
