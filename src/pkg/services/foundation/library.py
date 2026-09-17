from collections import Counter
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source, SourceMedia, SourceMediaSegment
from pkg.models.foundation.wiki import WikiPage
from pkg.schemas.library import (
    LibrarySearchHit,
    LibrarySearchRequest,
    LibrarySearchResponse,
    LibrarySearchResult,
)
from pkg.schemas.note import SearchResult
from pkg.services.cross_cutting.storage import get_storage_service
from pkg.services.foundation.retriever import RetrieverAgent


def _source_media_type(source_type: str | None) -> str:
    if source_type in {"image", "video"}:
        return source_type
    return "text"


def _metadata_tags(metadata: dict | None) -> list[str]:
    if not metadata:
        return []
    values = metadata.get("tags")
    if not isinstance(values, list):
        return []
    return [str(value) for value in values if str(value).strip()]


def _source_lifecycle(metadata: dict | None) -> str:
    if not metadata:
        return "active"
    return str(
        metadata.get("lifecycle_status")
        or metadata.get("review_status")
        or metadata.get("status")
        or "active"
    )


def _naive_datetime(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is None:
        return value
    return value.replace(tzinfo=None)


def _hit_field(result: SearchResult) -> str:
    if result.type == "video_segment":
        if result.match_reason and "caption" in result.match_reason.casefold():
            return "caption"
        return "transcript"
    if result.source_type == "image":
        return "caption"
    if result.type == "source_chunk":
        return "content"
    if result.abstract:
        return "summary"
    return "content"


def _default_hit_reason(result: SearchResult) -> str:
    if result.type == "video_segment":
        return "Matched this video segment."
    if result.source_type == "image":
        return "Matched the generated image caption or Source description."
    if result.type == "wiki":
        return "Matched this maintained Wiki Page."
    if result.type == "note":
        return "Matched this user-authored Note."
    return "Matched this Source."


class LibraryService:
    def __init__(self, session: AsyncSession, user_id: str):
        self.session = session
        self.user_id = user_id

    async def search(self, body: LibrarySearchRequest) -> LibrarySearchResponse:
        candidate_limit = min(200, max(body.offset + body.limit * 4, 50))
        if body.query.strip():
            legacy_results = await RetrieverAgent(self.session, user_id=self.user_id).search(
                query=body.query.strip(),
                mode=body.mode,
                top_k=candidate_limit,
                filters=self._retriever_filters(body),
            )
            legacy_results = [result for result in legacy_results if result.type != "asset"]
        else:
            legacy_results = await self._recent_results(body, candidate_limit)

        items = await self._enrich_results(legacy_results)
        items = [item for item in items if self._matches(item, body)]
        if not body.query.strip():
            items.sort(
                key=lambda item: item.updated_at or item.created_at or datetime.min,
                reverse=True,
            )

        facets = self._facets(items)
        total = len(items)
        page = items[body.offset : body.offset + body.limit]
        return LibrarySearchResponse(
            items=page,
            total=total,
            limit=body.limit,
            offset=body.offset,
            facets=facets,
        )

    def _retriever_filters(self, body: LibrarySearchRequest) -> dict | None:
        filters: dict[str, object] = {}
        if body.tags:
            filters["tags"] = body.tags
        if body.media_types and len(body.media_types) == 1:
            media_type = body.media_types[0]
            if media_type in {"image", "video"}:
                filters["source_type"] = media_type
        return filters or None

    async def _recent_results(
        self,
        body: LibrarySearchRequest,
        candidate_limit: int,
    ) -> list[SearchResult]:
        entity_types = set(body.entity_types or ("source", "note", "wiki"))
        results: list[SearchResult] = []

        if "source" in entity_types:
            stmt = select(Source).where(or_(Source.user_id == self.user_id, Source.is_shared))
            if body.media_types:
                media_clauses = []
                if "text" in body.media_types:
                    media_clauses.append(Source.source_type.not_in(("image", "video")))
                media_clauses.extend(
                    Source.source_type == media_type
                    for media_type in body.media_types
                    if media_type in {"image", "video"}
                )
                stmt = stmt.where(or_(*media_clauses))
            if body.date_from:
                stmt = stmt.where(Source.ingested_at >= _naive_datetime(body.date_from))
            if body.date_to:
                stmt = stmt.where(Source.ingested_at <= _naive_datetime(body.date_to))
            stmt = stmt.order_by(Source.ingested_at.desc()).limit(candidate_limit)
            rows = await self.session.execute(stmt)
            results.extend(
                SearchResult(
                    id=source.id,
                    title=source.title,
                    type="source",
                    layer="raw_evidence",
                    score=1.0,
                    abstract=source.description,
                    content_preview=(source.description or source.raw_content or "")[:200],
                    source_type=source.source_type,
                )
                for source in rows.scalars()
            )

        if "note" in entity_types:
            stmt = select(Note).where(Note.user_id == self.user_id)
            if body.tags:
                stmt = stmt.where(Note.tags.overlap(body.tags))
            if body.lifecycle_statuses:
                stmt = stmt.where(Note.status.in_(body.lifecycle_statuses))
            if body.date_from:
                stmt = stmt.where(Note.updated_at >= _naive_datetime(body.date_from))
            if body.date_to:
                stmt = stmt.where(Note.updated_at <= _naive_datetime(body.date_to))
            stmt = stmt.order_by(Note.updated_at.desc()).limit(candidate_limit)
            rows = await self.session.execute(stmt)
            results.extend(
                SearchResult(
                    id=note.id,
                    title=note.title,
                    type="note",
                    layer="user_note",
                    score=1.0,
                    abstract=note.abstract,
                    content_preview=(note.content or "")[:200],
                )
                for note in rows.scalars()
            )

        if "wiki" in entity_types:
            stmt = select(WikiPage).where(WikiPage.user_id == self.user_id)
            if body.tags:
                stmt = stmt.where(WikiPage.tags.overlap(body.tags))
            if body.lifecycle_statuses:
                stmt = stmt.where(WikiPage.lifecycle_status.in_(body.lifecycle_statuses))
            if body.date_from:
                stmt = stmt.where(WikiPage.updated_at >= _naive_datetime(body.date_from))
            if body.date_to:
                stmt = stmt.where(WikiPage.updated_at <= _naive_datetime(body.date_to))
            stmt = stmt.order_by(WikiPage.updated_at.desc()).limit(candidate_limit)
            rows = await self.session.execute(stmt)
            results.extend(
                SearchResult(
                    id=wiki.id,
                    title=wiki.title,
                    type="wiki",
                    layer="stable_wiki",
                    score=1.0,
                    abstract=wiki.summary,
                    content_preview=(wiki.content or "")[:200],
                )
                for wiki in rows.scalars()
            )
        return results

    async def _enrich_results(
        self,
        results: list[SearchResult],
    ) -> list[LibrarySearchResult]:
        source_ids = {result.id for result in results if result.type in {"source", "source_chunk", "video_segment"}}
        note_ids = {result.id for result in results if result.type == "note"}
        wiki_ids = {result.id for result in results if result.type == "wiki"}

        sources = await self._load_map(Source, source_ids)
        notes = await self._load_map(Note, note_ids)
        wikis = await self._load_map(WikiPage, wiki_ids)
        media_by_source: dict[str, SourceMedia] = {}
        if source_ids:
            rows = await self.session.execute(
                select(SourceMedia).where(SourceMedia.source_id.in_(source_ids))
            )
            media_by_source = {media.source_id: media for media in rows.scalars()}
        segment_ids = {result.segment_id for result in results if result.segment_id is not None}
        segments: dict[int, SourceMediaSegment] = {}
        if segment_ids:
            rows = await self.session.execute(
                select(SourceMediaSegment).where(SourceMediaSegment.id.in_(segment_ids))
            )
            segments = {segment.id: segment for segment in rows.scalars()}

        storage = get_storage_service()
        items: list[LibrarySearchResult] = []
        for result in results:
            excerpt = result.abstract or result.content_preview
            hit = LibrarySearchHit(
                field=_hit_field(result),
                reason=result.match_reason or _default_hit_reason(result),
                text=result.content_preview or result.abstract,
            )
            if result.type in {"source", "source_chunk", "video_segment"}:
                source = sources.get(result.id)
                if source is None:
                    continue
                media = media_by_source.get(result.id)
                segment = segments.get(result.segment_id) if result.segment_id is not None else None
                thumbnail_url = result.thumbnail_url
                thumbnail_path = segment.thumbnail_path if segment else None
                if thumbnail_path is None and media:
                    thumbnail_path = media.thumbnail_path
                if thumbnail_url is None and thumbnail_path:
                    thumbnail_url = await storage.generate_download_url(thumbnail_path)
                playback_url = result.playback_url
                if playback_url is None and result.type == "video_segment" and source.file_path:
                    playback_url = await storage.generate_download_url(source.file_path)
                if result.source_type == "image" and media and media.caption:
                    hit.text = hit.text or media.caption
                items.append(
                    LibrarySearchResult(
                        id=result.id,
                        entity_type="source",
                        result_type=result.type,
                        media_type=_source_media_type(source.source_type),
                        title=result.title,
                        excerpt=excerpt,
                        score=result.score,
                        href=f"/sources/{result.id}",
                        created_at=source.ingested_at,
                        updated_at=media.updated_at if media else source.ingested_at,
                        tags=_metadata_tags(source.metadata_),
                        lifecycle_status=_source_lifecycle(source.metadata_),
                        source_type=source.source_type,
                        thumbnail_url=thumbnail_url,
                        playback_url=playback_url,
                        segment_id=result.segment_id,
                        start_ms=result.start_ms,
                        end_ms=result.end_ms,
                        hit=hit,
                    )
                )
            elif result.type == "note":
                note = notes.get(result.id)
                if note is None:
                    continue
                items.append(
                    LibrarySearchResult(
                        id=result.id,
                        entity_type="note",
                        result_type="note",
                        media_type=None,
                        title=result.title,
                        excerpt=excerpt,
                        score=result.score,
                        href=f"/notes/{result.id}",
                        created_at=note.created_at,
                        updated_at=note.updated_at,
                        tags=list(note.tags or []),
                        lifecycle_status=note.status,
                        hit=hit,
                    )
                )
            elif result.type == "wiki":
                wiki = wikis.get(result.id)
                if wiki is None:
                    continue
                items.append(
                    LibrarySearchResult(
                        id=result.id,
                        entity_type="wiki",
                        result_type="wiki",
                        media_type=None,
                        title=result.title,
                        excerpt=excerpt,
                        score=result.score,
                        href=f"/wiki/{result.id}",
                        created_at=wiki.created_at,
                        updated_at=wiki.updated_at,
                        tags=list(wiki.tags or []),
                        lifecycle_status=wiki.lifecycle_status,
                        hit=hit,
                    )
                )
        return items

    async def _load_map(self, model, ids: set[str]) -> dict[str, object]:
        if not ids:
            return {}
        rows = await self.session.execute(select(model).where(model.id.in_(ids)))
        return {item.id: item for item in rows.scalars()}

    def _matches(self, item: LibrarySearchResult, body: LibrarySearchRequest) -> bool:
        if body.entity_types and item.entity_type not in body.entity_types:
            return False
        if body.media_types:
            if item.entity_type != "source" or item.media_type not in body.media_types:
                return False
        if body.lifecycle_statuses and item.lifecycle_status not in body.lifecycle_statuses:
            return False
        if body.tags and not set(body.tags).intersection(item.tags):
            return False
        item_date = _naive_datetime(item.updated_at or item.created_at)
        date_from = _naive_datetime(body.date_from)
        date_to = _naive_datetime(body.date_to)
        if date_from and (item_date is None or item_date < date_from):
            return False
        if date_to and (item_date is None or item_date > date_to):
            return False
        return True

    def _facets(self, items: list[LibrarySearchResult]) -> dict[str, dict[str, int]]:
        return {
            "entity_type": dict(Counter(item.entity_type for item in items)),
            "media_type": dict(Counter(item.media_type for item in items if item.media_type)),
            "lifecycle_status": dict(
                Counter(item.lifecycle_status for item in items if item.lifecycle_status)
            ),
        }
