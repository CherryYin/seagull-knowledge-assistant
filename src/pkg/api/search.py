from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import get_session
from pkg.models.user import User
from pkg.models.foundation.source import Source, SourceMedia, SourceMediaSegment
from pkg.schemas.note import SearchRequest, SearchResult
from pkg.services.cross_cutting.activity import log_activity
from pkg.services.foundation.retriever import RetrieverAgent
from pkg.services.cross_cutting.stats import increment_stats
from pkg.services.cross_cutting.storage import get_storage_service
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
    source_ids = [
        r.id for r in results if r.type in ("source", "source_chunk", "video_segment")
    ]
    if source_ids:
        media_rows = await session.execute(
            select(SourceMedia).where(SourceMedia.source_id.in_(set(source_ids)))
        )
        media_by_source = {media.source_id: media for media in media_rows.scalars()}
        storage = get_storage_service()
        normalized_query = body.query.casefold()
        for result in results:
            media = media_by_source.get(result.id)
            if media is None:
                continue
            if media.thumbnail_path:
                result.thumbnail_url = await storage.generate_download_url(media.thumbnail_path)
            if media.caption and result.type != "video_segment":
                result.content_preview = result.content_preview or media.caption[:200]
                if normalized_query and normalized_query in media.caption.casefold():
                    result.match_reason = "Matched text in the generated media caption."
                else:
                    result.match_reason = "Semantic match from the generated media caption."
    segment_ids = [result.segment_id for result in results if result.segment_id is not None]
    if segment_ids:
        segment_rows = await session.execute(
            select(SourceMediaSegment).where(SourceMediaSegment.id.in_(segment_ids))
        )
        segments = {segment.id: segment for segment in segment_rows.scalars()}
        video_source_ids = {
            result.id for result in results if result.type == "video_segment"
        }
        source_rows = await session.execute(select(Source).where(Source.id.in_(video_source_ids)))
        sources = {source.id: source for source in source_rows.scalars()}
        storage = get_storage_service()
        for result in results:
            if result.segment_id is None:
                continue
            segment = segments.get(result.segment_id)
            source = sources.get(result.id)
            if segment and segment.thumbnail_path:
                result.thumbnail_url = await storage.generate_download_url(segment.thumbnail_path)
            if source and source.file_path:
                result.playback_url = await storage.generate_download_url(source.file_path)
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
