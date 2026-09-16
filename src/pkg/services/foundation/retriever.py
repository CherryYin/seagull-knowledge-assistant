from sqlalchemy import select, text, or_
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source, SourceMediaSegment
from pkg.models.foundation.wiki import WikiPage
from pkg.models.application.asset import Asset
from pkg.schemas.note import SearchResult
from pkg.services.cross_cutting.embedding import get_embedding_service


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _result_layer(result_type: str) -> str:
    if result_type in {"source", "source_chunk", "video_segment"}:
        return "raw_evidence"
    if result_type == "note":
        return "user_note"
    if result_type == "wiki":
        return "stable_wiki"
    if result_type == "asset":
        return "asset"
    return "knowledge"


class RetrieverAgent:
    def __init__(self, session: AsyncSession, user_id: str | None = None):
        self.session = session
        self.emb = get_embedding_service()
        self.user_id = user_id

    async def search(
        self, query: str, mode: str = "auto", top_k: int = 5, filters: dict | None = None
    ) -> list[SearchResult]:
        if mode == "auto":
            mode = self._detect_mode(query, filters)

        if mode == "sql":
            results = await self.sql_search(query, filters, top_k)
        elif mode == "vector":
            results = await self.vector_search(query, top_k)
        elif mode == "hybrid":
            results = await self.hybrid_search(query, filters, top_k)
        else:
            results = await self.vector_search(query, top_k)
        return self._merge_adjacent_video_segments(results, top_k)

    def _merge_adjacent_video_segments(
        self,
        results: list[SearchResult],
        top_k: int,
    ) -> list[SearchResult]:
        merged: list[SearchResult] = []
        for result in sorted(results, key=lambda item: item.score, reverse=True):
            if result.type != "video_segment" or result.start_ms is None or result.end_ms is None:
                merged.append(result)
                continue
            adjacent = next(
                (
                    item
                    for item in merged
                    if item.type == "video_segment"
                    and item.id == result.id
                    and item.start_ms is not None
                    and item.end_ms is not None
                    and result.start_ms <= item.end_ms + 5000
                    and result.end_ms >= item.start_ms - 5000
                ),
                None,
            )
            if adjacent is None:
                merged.append(result)
                continue
            adjacent.start_ms = min(adjacent.start_ms, result.start_ms)
            adjacent.end_ms = max(adjacent.end_ms, result.end_ms)
            if result.content_preview and result.content_preview not in (adjacent.content_preview or ""):
                adjacent.content_preview = " ".join(
                    value for value in (adjacent.content_preview, result.content_preview) if value
                )[:400]
            adjacent.score = max(adjacent.score, result.score)
        merged.sort(key=lambda item: item.score, reverse=True)
        return merged[:top_k]

    def _detect_mode(self, query: str, filters: dict | None) -> str:
        if filters:
            return "hybrid"
        return "vector"

    def _vector_literal(self, values: list[float]) -> str:
        return "[" + ",".join(f"{value:.8f}" for value in values) + "]"

    async def sql_search(
        self, query: str, filters: dict | None = None, top_k: int = 5
    ) -> list[SearchResult]:
        results: list[SearchResult] = []

        # Search notes
        stmt = select(Note)
        if self.user_id:
            stmt = stmt.where(Note.user_id == self.user_id)
        if filters:
            if "domains" in filters:
                stmt = stmt.where(Note.domains.overlap(filters["domains"]))
            if "tags" in filters:
                stmt = stmt.where(Note.tags.overlap(filters["tags"]))
            if "project" in filters:
                stmt = stmt.where(Note.project == filters["project"])
            if "note_type" in filters:
                stmt = stmt.where(Note.note_type == filters["note_type"])
            if "status" in filters:
                stmt = stmt.where(Note.status == filters["status"])
        if query:
            like_pattern = f"%{_escape_like(query)}%"
            stmt = stmt.where(
                or_(Note.title.ilike(like_pattern), Note.abstract.ilike(like_pattern))
            )
        stmt = stmt.limit(top_k)

        rows = await self.session.execute(stmt)
        for note in rows.scalars():
            results.append(SearchResult(
                id=note.id,
                title=note.title,
                type="note",
                layer=_result_layer("note"),
                score=1.0,
                abstract=note.abstract,
                content_preview=(note.content or "")[:200],
            ))

        wiki_stmt = select(WikiPage)
        if self.user_id:
            wiki_stmt = wiki_stmt.where(WikiPage.user_id == self.user_id)
        if query:
            like_pattern = f"%{_escape_like(query)}%"
            wiki_stmt = wiki_stmt.where(
                or_(WikiPage.title.ilike(like_pattern), WikiPage.summary.ilike(like_pattern))
            )
        wiki_stmt = wiki_stmt.limit(top_k)

        rows = await self.session.execute(wiki_stmt)
        for wiki in rows.scalars():
            results.append(SearchResult(
                id=wiki.id,
                title=wiki.title,
                type="wiki",
                layer=_result_layer("wiki"),
                score=1.08,
                abstract=wiki.summary,
                content_preview=(wiki.content or "")[:200],
            ))

        asset_stmt = select(Asset)
        if self.user_id:
            asset_stmt = asset_stmt.where(Asset.user_id == self.user_id)
        if query:
            like_pattern = f"%{_escape_like(query)}%"
            asset_stmt = asset_stmt.where(
                or_(Asset.title.ilike(like_pattern), Asset.brief.ilike(like_pattern), Asset.draft_content.ilike(like_pattern))
            )
        asset_stmt = asset_stmt.limit(top_k)

        rows = await self.session.execute(asset_stmt)
        for asset in rows.scalars():
            results.append(SearchResult(
                id=asset.id,
                title=asset.title,
                type="asset",
                layer=_result_layer("asset"),
                score=0.95,
                abstract=asset.brief,
                content_preview=(asset.draft_content or asset.outline or "")[:200],
            ))

        # Search sources
        src_stmt = select(Source)
        if self.user_id:
            src_stmt = src_stmt.where(or_(Source.user_id == self.user_id, Source.is_shared))
        if query:
            like_pattern = f"%{_escape_like(query)}%"
            src_stmt = src_stmt.where(
                or_(
                    Source.title.ilike(like_pattern),
                    Source.description.ilike(like_pattern),
                    Source.raw_content.ilike(like_pattern),
                )
            )
        if filters and "source_type" in filters:
            src_stmt = src_stmt.where(Source.source_type == filters["source_type"])
        src_stmt = src_stmt.limit(top_k)

        rows = await self.session.execute(src_stmt)
        for src in rows.scalars():
            results.append(SearchResult(
                id=src.id,
                title=src.title,
                type="source",
                layer=_result_layer("source"),
                score=1.0,
                abstract=src.description,
                content_preview=(src.description or src.raw_content or "")[:200],
                source_type=src.source_type,
            ))

        segment_stmt = select(SourceMediaSegment, Source).join(
            Source, Source.id == SourceMediaSegment.source_id
        )
        if self.user_id:
            segment_stmt = segment_stmt.where(
                or_(Source.user_id == self.user_id, Source.is_shared)
            )
        if query:
            like_pattern = f"%{_escape_like(query)}%"
            segment_stmt = segment_stmt.where(
                or_(
                    SourceMediaSegment.transcript.ilike(like_pattern),
                    SourceMediaSegment.caption.ilike(like_pattern),
                )
            )
        if filters and "source_type" in filters and filters["source_type"] != "video":
            segment_stmt = segment_stmt.where(False)
        segment_stmt = segment_stmt.order_by(SourceMediaSegment.start_ms.asc()).limit(top_k)
        rows = await self.session.execute(segment_stmt)
        for segment, source in rows:
            preview = segment.transcript or segment.caption
            results.append(SearchResult(
                id=source.id,
                segment_id=segment.id,
                title=source.title,
                type="video_segment",
                layer=_result_layer("video_segment"),
                score=1.1,
                abstract=source.description,
                content_preview=(preview or "")[:200],
                source_type="video",
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                match_reason=(
                    "Matched spoken transcript in this video segment."
                    if segment.transcript and query.casefold() in segment.transcript.casefold()
                    else "Matched the generated caption for this video segment."
                ),
            ))

        results.sort(key=lambda item: item.score, reverse=True)
        return results[:top_k]

    async def vector_search(self, query: str, top_k: int = 5) -> list[SearchResult]:
        query_vec = await self.emb.embed_text(query)
        query_vec_literal = self._vector_literal(query_vec)
        results: list[SearchResult] = []

        # Build optional user filter clauses for raw SQL
        note_user_clause = ""
        source_user_clause = ""
        user_params: dict = {}
        if self.user_id:
            note_user_clause = "WHERE n.user_id = :user_id"
            source_user_clause = "WHERE (s.user_id = :user_id OR s.is_shared = true)"
            user_params["user_id"] = self.user_id

        # Search note embeddings
        note_stmt = text(f"""
            SELECT ne.note_id, n.title, n.abstract, n.content,
                   1 - (ne.abstract_vec <=> CAST(:query_vec AS vector)) AS score
            FROM note_embeddings ne
            JOIN notes n ON n.id = ne.note_id
            {note_user_clause}
            ORDER BY ne.abstract_vec <=> CAST(:query_vec AS vector)
            LIMIT :top_k
        """)
        rows = await self.session.execute(
            note_stmt, {"query_vec": query_vec_literal, "top_k": top_k, **user_params}
        )
        for row in rows:
            results.append(SearchResult(
                id=row.note_id,
                title=row.title,
                type="note",
                layer=_result_layer("note"),
                score=float(row.score),
                abstract=row.abstract,
                content_preview=(row.content or "")[:200],
            ))

        # Search wiki embeddings (L3 long-term knowledge pages)
        wiki_user_clause = ""
        if self.user_id:
            wiki_user_clause = "WHERE w.user_id = :user_id"
        wiki_stmt = text(f"""
            SELECT we.wiki_id, w.title, w.summary, w.content,
                   1 - (we.content_vec <=> CAST(:query_vec AS vector)) AS score
            FROM wiki_embeddings we
            JOIN wiki_pages w ON w.id = we.wiki_id
            {wiki_user_clause}
            ORDER BY we.content_vec <=> CAST(:query_vec AS vector)
            LIMIT :top_k
        """)
        rows = await self.session.execute(
            wiki_stmt, {"query_vec": query_vec_literal, "top_k": top_k, **user_params}
        )
        for row in rows:
            results.append(SearchResult(
                id=row.wiki_id,
                title=row.title,
                type="wiki",
                layer=_result_layer("wiki"),
                score=float(row.score) * 1.05,
                abstract=row.summary,
                content_preview=(row.content or "")[:200],
            ))

        asset_user_clause = ""
        if self.user_id:
            asset_user_clause = "WHERE a.user_id = :user_id"
        asset_stmt = text(f"""
            SELECT a.id, a.title, a.brief, a.draft_content,
                   ts_rank_cd(
                     setweight(to_tsvector('simple', coalesce(a.title, '')), 'A') ||
                     setweight(to_tsvector('simple', coalesce(a.brief, '')), 'B') ||
                     setweight(to_tsvector('simple', coalesce(a.draft_content, '')), 'C'),
                     plainto_tsquery('simple', :query)
                   ) AS score
            FROM assets a
            {asset_user_clause}
            ORDER BY score DESC NULLS LAST, a.updated_at DESC
            LIMIT :top_k
        """)
        rows = await self.session.execute(
            asset_stmt, {"query": query, "top_k": top_k, **user_params}
        )
        for row in rows:
            results.append(SearchResult(
                id=row.id,
                title=row.title,
                type="asset",
                layer=_result_layer("asset"),
                score=float(row.score or 0.0),
                abstract=row.brief,
                content_preview=(row.draft_content or "")[:200],
            ))

        # Search source embeddings (document-level)
        src_stmt = text(f"""
            SELECT se.source_id, s.title, s.description, s.raw_content, s.source_type,
                   1 - (se.summary_vec <=> CAST(:query_vec AS vector)) AS score
            FROM source_embeddings se
            JOIN sources s ON s.id = se.source_id
            {source_user_clause}
            ORDER BY se.summary_vec <=> CAST(:query_vec AS vector)
            LIMIT :top_k
        """)
        rows = await self.session.execute(
            src_stmt, {"query_vec": query_vec_literal, "top_k": top_k, **user_params}
        )
        for row in rows:
            results.append(SearchResult(
                id=row.source_id,
                title=row.title,
                type="source",
                layer=_result_layer("source"),
                score=float(row.score),
                abstract=row.description,
                content_preview=(row.description or row.raw_content or "")[:200],
                source_type=row.source_type,
            ))

        # Search source chunks (fine-grained, within long documents)
        chunk_stmt = text(f"""
            SELECT sc.source_id, s.title, s.description, s.source_type, sc.content,
                   1 - (sc.embedding <=> CAST(:query_vec AS vector)) AS score
            FROM source_chunks sc
            JOIN sources s ON s.id = sc.source_id
            {source_user_clause}
            ORDER BY sc.embedding <=> CAST(:query_vec AS vector)
            LIMIT :top_k
        """)
        rows = await self.session.execute(
            chunk_stmt, {"query_vec": query_vec_literal, "top_k": top_k, **user_params}
        )
        for row in rows:
            results.append(SearchResult(
                id=row.source_id,
                title=row.title,
                type="source_chunk",
                layer=_result_layer("source_chunk"),
                score=float(row.score),
                abstract=row.description,
                content_preview=row.content[:200],
                source_type=row.source_type,
            ))

        segment_user_clause = "WHERE sms.embedding IS NOT NULL"
        if self.user_id:
            segment_user_clause += " AND (s.user_id = :user_id OR s.is_shared = true)"
        segment_stmt = text(f"""
            SELECT sms.id AS segment_id, sms.source_id, s.title, s.description,
                   sms.start_ms, sms.end_ms, sms.transcript, sms.caption,
                   1 - (sms.embedding <=> CAST(:query_vec AS vector)) AS score
            FROM source_media_segments sms
            JOIN sources s ON s.id = sms.source_id
            {segment_user_clause}
            ORDER BY sms.embedding <=> CAST(:query_vec AS vector)
            LIMIT :top_k
        """)
        rows = await self.session.execute(
            segment_stmt, {"query_vec": query_vec_literal, "top_k": top_k, **user_params}
        )
        for row in rows:
            results.append(SearchResult(
                id=row.source_id,
                segment_id=row.segment_id,
                title=row.title,
                type="video_segment",
                layer=_result_layer("video_segment"),
                score=float(row.score) * 1.08,
                abstract=row.description,
                content_preview=(row.transcript or row.caption or "")[:200],
                source_type="video",
                start_ms=row.start_ms,
                end_ms=row.end_ms,
                match_reason="Semantic match in a video transcript or scene caption.",
            ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]

    async def hybrid_search(
        self, query: str, filters: dict | None = None, top_k: int = 5
    ) -> list[SearchResult]:
        sql_results = await self.sql_search(query, filters, top_k * 2)
        vec_results = await self.vector_search(query, top_k * 2)

        # Merge: prefer vector score, deduplicate by (type, id)
        seen = set()
        merged = []
        for r in vec_results:
            key = (r.type, r.id, r.segment_id)
            if key not in seen:
                seen.add(key)
                merged.append(r)
        for r in sql_results:
            key = (r.type, r.id, r.segment_id)
            if key not in seen:
                seen.add(key)
                r.score = r.score * 0.8  # slight penalty for SQL-only matches
                merged.append(r)

        merged.sort(key=lambda r: r.score, reverse=True)
        return merged[:top_k]
