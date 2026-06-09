"""Unified Memory retrieval service for Phase B.

This service centralizes how the system retrieves Memory Tree nodes for chat,
profile generation, wiki workflows, and future discovery scoring.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import logging
import re

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.memory import MemoryNode
from pkg.services.cross_cutting.embedding import get_embedding_service

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class MemoryRetrievalResult:
    node: MemoryNode
    score: float
    matched_reason: str

    @property
    def id(self) -> str:
        return self.node.id

    @property
    def title(self) -> str:
        return self.node.title

    @property
    def summary(self) -> str | None:
        return self.node.summary

    @property
    def content(self) -> str:
        return self.node.content


async def retrieve_for_query(
    session: AsyncSession,
    *,
    user_id: str,
    query: str,
    node_type: str | None = None,
    level: str | None = None,
    limit: int = 8,
) -> list[MemoryRetrievalResult]:
    """Retrieve memory nodes relevant to a free-form user query."""
    query = query.strip()
    if not query:
        return await retrieve_recent(session, user_id=user_id, limit=limit)

    semantic = await _semantic_search(
        session,
        user_id=user_id,
        query=query,
        node_type=node_type,
        level=level,
        limit=limit,
    )
    keyword = await _keyword_search(
        session,
        user_id=user_id,
        query=query,
        node_type=node_type,
        level=level,
        limit=limit,
    )
    return _merge_ranked_results([semantic, keyword], limit=limit)


async def retrieve_for_profile(
    session: AsyncSession,
    *,
    user_id: str,
    limit: int = 30,
) -> list[MemoryRetrievalResult]:
    """Retrieve high-value memories for user profile generation."""
    stmt = (
        select(MemoryNode)
        .where(MemoryNode.user_id == user_id)
        .where(_active_filter())
        .order_by(
            MemoryNode.confidence_score.desc().nullslast(),
            MemoryNode.updated_at.desc(),
        )
        .limit(limit)
    )
    rows = await session.execute(stmt)
    results: list[MemoryRetrievalResult] = []
    for index, node in enumerate(rows.scalars()):
        confidence = node.confidence_score if node.confidence_score is not None else 0.45
        level_bonus = 0.2 if node.level in {"topic", "global", "conversation"} else 0.0
        results.append(MemoryRetrievalResult(node=node, score=confidence + level_bonus - index * 0.001, matched_reason="profile candidate"))
    return results


async def retrieve_for_wiki(
    session: AsyncSession,
    *,
    user_id: str,
    topic: str,
    source_ids: list[str] | None = None,
    limit: int = 12,
) -> list[MemoryRetrievalResult]:
    """Retrieve topic and evidence memories for wiki draft/recompile workflows."""
    results = await retrieve_for_query(session, user_id=user_id, query=topic, limit=limit)
    if source_ids:
        related = await retrieve_by_relation(session, user_id=user_id, source_id=source_ids[0], limit=limit)
        for source_id in source_ids[1:]:
            related.extend(await retrieve_by_relation(session, user_id=user_id, source_id=source_id, limit=limit))
        results = _merge_ranked_results([results, related], limit=limit)
    return results


async def retrieve_recent(
    session: AsyncSession,
    *,
    user_id: str,
    days: int = 30,
    limit: int = 10,
) -> list[MemoryRetrievalResult]:
    """Retrieve recently updated active memories."""
    since = datetime.now(timezone.utc) - timedelta(days=max(1, days))
    stmt = (
        select(MemoryNode)
        .where(MemoryNode.user_id == user_id)
        .where(_active_filter())
        .where(MemoryNode.updated_at >= since)
        .order_by(MemoryNode.updated_at.desc())
        .limit(limit)
    )
    rows = await session.execute(stmt)
    return [MemoryRetrievalResult(node=node, score=0.5 - index * 0.001, matched_reason=f"recent memory within {days} days") for index, node in enumerate(rows.scalars())]


async def retrieve_by_relation(
    session: AsyncSession,
    *,
    user_id: str,
    source_id: str | None = None,
    note_id: str | None = None,
    wiki_id: str | None = None,
    limit: int = 10,
) -> list[MemoryRetrievalResult]:
    """Retrieve memories directly related to a source, note, or wiki page."""
    filters = [MemoryNode.user_id == user_id, _active_filter()]
    reason = "related memory"
    if source_id:
        filters.append(MemoryNode.derived_from_sources.any(source_id))
        reason = f"related source {source_id}"
    elif note_id:
        filters.append(MemoryNode.derived_from_notes.any(note_id))
        reason = f"related note {note_id}"
    elif wiki_id:
        try:
            from pkg.models.foundation.wiki import WikiPageMemory

            rows = await session.execute(
                select(WikiPageMemory.memory_node_id).where(WikiPageMemory.wiki_id == wiki_id).limit(limit)
            )
            memory_ids = list(rows.scalars())
        except Exception:
            logger.exception("Failed to load wiki memory relations for %s", wiki_id)
            memory_ids = []
        if not memory_ids:
            return []
        filters.append(MemoryNode.id.in_(memory_ids))
        reason = f"related wiki {wiki_id}"
    else:
        return []

    stmt = select(MemoryNode).where(*filters).order_by(MemoryNode.updated_at.desc()).limit(limit)
    rows = await session.execute(stmt)
    return [MemoryRetrievalResult(node=node, score=0.75 - index * 0.001, matched_reason=reason) for index, node in enumerate(rows.scalars())]


def format_memory_context(results: list[MemoryRetrievalResult], *, max_chars_per_item: int = 700) -> str:
    """Format retrieved memories into a compact prompt/context block."""
    if not results:
        return ""
    lines = ["Relevant long-term memory:"]
    for index, result in enumerate(results, 1):
        node = result.node
        body = " ".join((node.summary or node.content or "").split())
        if len(body) > max_chars_per_item:
            body = body[:max_chars_per_item].rstrip() + "…"
        lines.append(
            f"{index}. [{node.node_type}/{node.level}] {node.title} "
            f"(id={node.id}, confidence={node.confidence_score if node.confidence_score is not None else 'unknown'}, reason={result.matched_reason})\n"
            f"   {body}"
        )
    return "\n".join(lines)


async def _semantic_search(
    session: AsyncSession,
    *,
    user_id: str,
    query: str,
    node_type: str | None,
    level: str | None,
    limit: int,
) -> list[MemoryRetrievalResult]:
    try:
        emb_svc = get_embedding_service()
        query_vec = await emb_svc.embed_text(query)
        query_vec_literal = "[" + ",".join(f"{value:.8f}" for value in query_vec) + "]"
        filters = ["m.user_id = :user_id"]
        params: dict[str, object] = {"query_vec": query_vec_literal, "user_id": user_id, "limit": limit}
        if node_type:
            filters.append("m.node_type = :node_type")
            params["node_type"] = node_type
        if level:
            filters.append("m.level = :level")
            params["level"] = level
        filters.append("COALESCE(m.metadata->>'status', 'active') = 'active'")
        where_sql = " AND ".join(filters)
        stmt = text(f"""
            SELECT m.id, 1 - (me.content_vec <=> CAST(:query_vec AS vector)) AS score
            FROM memory_embeddings me
            JOIN memory_nodes m ON m.id = me.memory_node_id
            WHERE {where_sql}
            ORDER BY me.content_vec <=> CAST(:query_vec AS vector)
            LIMIT :limit
        """)
        rows = await session.execute(stmt, params)
        scored_ids = [(row.id, float(row.score or 0.0)) for row in rows]
        if not scored_ids:
            return []
        nodes = await _load_nodes_by_id(session, [node_id for node_id, _score in scored_ids])
        return [MemoryRetrievalResult(node=nodes[node_id], score=score, matched_reason=f"semantic match {score:.3f}") for node_id, score in scored_ids if node_id in nodes]
    except Exception:
        logger.exception("Semantic memory retrieval failed")
        return []


async def _keyword_search(
    session: AsyncSession,
    *,
    user_id: str,
    query: str,
    node_type: str | None,
    level: str | None,
    limit: int,
) -> list[MemoryRetrievalResult]:
    terms = _keywords(query)
    filters = [MemoryNode.user_id == user_id, _active_filter()]
    if node_type:
        filters.append(MemoryNode.node_type == node_type)
    if level:
        filters.append(MemoryNode.level == level)
    if terms:
        clauses = []
        for term in terms[:8]:
            pattern = f"%{_escape_like(term)}%"
            clauses.extend([MemoryNode.title.ilike(pattern), MemoryNode.summary.ilike(pattern), MemoryNode.content.ilike(pattern)])
        filters.append(or_(*clauses))
    stmt = select(MemoryNode).where(*filters).order_by(MemoryNode.updated_at.desc()).limit(limit * 3)
    rows = await session.execute(stmt)
    results = []
    for node in rows.scalars():
        haystack = " ".join([node.title or "", node.summary or "", node.content or ""]).lower()
        matches = [term for term in terms if term.lower() in haystack]
        score = 0.35 + min(len(matches), 6) * 0.08 + (node.confidence_score or 0) * 0.1
        results.append(MemoryRetrievalResult(node=node, score=score, matched_reason=f"keyword match: {', '.join(matches[:4]) or query}"))
    results.sort(key=lambda item: item.score, reverse=True)
    return results[:limit]


async def _load_nodes_by_id(session: AsyncSession, node_ids: list[str]) -> dict[str, MemoryNode]:
    rows = await session.execute(select(MemoryNode).where(MemoryNode.id.in_(node_ids)))
    return {node.id: node for node in rows.scalars()}


def _merge_ranked_results(groups: list[list[MemoryRetrievalResult]], *, limit: int) -> list[MemoryRetrievalResult]:
    merged: dict[str, MemoryRetrievalResult] = {}
    for group in groups:
        for result in group:
            existing = merged.get(result.node.id)
            if existing is None or result.score > existing.score:
                merged[result.node.id] = result
            elif existing and result.matched_reason not in existing.matched_reason:
                existing.matched_reason = f"{existing.matched_reason}; {result.matched_reason}"
    return sorted(merged.values(), key=lambda item: item.score, reverse=True)[:limit]


def _active_filter():
    return or_(
        MemoryNode.metadata_.is_(None),
        ~MemoryNode.metadata_.has_key("status"),  # noqa: W601 - SQLAlchemy JSONB has_key operator
        MemoryNode.metadata_["status"].astext == "active",
    )


def _keywords(text_value: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", text_value.lower())
    stop = {"the", "and", "for", "with", "from", "this", "that", "memory", "source", "note", "wiki", "一个", "这个", "以及", "可以"}
    result: list[str] = []
    seen: set[str] = set()
    for word in words:
        if word in stop or word in seen:
            continue
        seen.add(word)
        result.append(word)
    return result[:20]


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
