from sqlalchemy import select, text, func, or_, any_
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.note import Note, NoteEmbedding
from pkg.models.source import Source, SourceEmbedding
from pkg.schemas.note import SearchResult
from pkg.services.embedding import get_embedding_service


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


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
            return await self.sql_search(query, filters, top_k)
        elif mode == "vector":
            return await self.vector_search(query, top_k)
        elif mode == "hybrid":
            return await self.hybrid_search(query, filters, top_k)
        return await self.vector_search(query, top_k)

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
                score=1.0,
                abstract=note.abstract,
                content_preview=(note.content or "")[:200],
            ))

        # Search sources
        src_stmt = select(Source)
        if self.user_id:
            src_stmt = src_stmt.where(or_(Source.user_id == self.user_id, Source.is_shared == True))
        if query:
            like_pattern = f"%{_escape_like(query)}%"
            src_stmt = src_stmt.where(Source.title.ilike(like_pattern))
        if filters and "source_type" in filters:
            src_stmt = src_stmt.where(Source.source_type == filters["source_type"])
        src_stmt = src_stmt.limit(top_k)

        rows = await self.session.execute(src_stmt)
        for src in rows.scalars():
            results.append(SearchResult(
                id=src.id,
                title=src.title,
                type="source",
                score=1.0,
                content_preview=(src.raw_content or "")[:200],
            ))

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
                score=float(row.score),
                abstract=row.abstract,
                content_preview=(row.content or "")[:200],
            ))

        # Search source embeddings (document-level)
        src_stmt = text(f"""
            SELECT se.source_id, s.title, s.raw_content,
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
                score=float(row.score),
                content_preview=(row.raw_content or "")[:200],
            ))

        # Search source chunks (fine-grained, within long documents)
        chunk_stmt = text(f"""
            SELECT sc.source_id, s.title, sc.content,
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
                score=float(row.score),
                content_preview=row.content[:200],
            ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]

    async def hybrid_search(
        self, query: str, filters: dict | None = None, top_k: int = 5
    ) -> list[SearchResult]:
        sql_results = await self.sql_search(query, filters, top_k * 2)
        vec_results = await self.vector_search(query, top_k * 2)

        # Merge: prefer vector score, deduplicate by id
        seen = set()
        merged = []
        for r in vec_results:
            if r.id not in seen:
                seen.add(r.id)
                merged.append(r)
        for r in sql_results:
            if r.id not in seen:
                seen.add(r.id)
                r.score = r.score * 0.8  # slight penalty for SQL-only matches
                merged.append(r)

        merged.sort(key=lambda r: r.score, reverse=True)
        return merged[:top_k]
