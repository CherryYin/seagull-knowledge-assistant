"""Memory Tree compilers and embedding helpers."""

import hashlib
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.memory import MemoryEmbedding, MemoryNode
from pkg.services.embedding import get_embedding_service
from pkg.services.memory_edges import sync_memory_edges_for_node
from pkg.services.wiki_recompile import suggest_wiki_recompile_for_trigger

logger = logging.getLogger(__name__)

_TOPIC_PROMPT = """\
你是个人知识图谱的 Topic Memory Tree 编译器。请把输入的 memory nodes 聚合成一个长期可复用的 topic-level memory。

要求：
1. 输出 Markdown。
2. 包含：主题概览、稳定结论、关键证据、相关子主题、开放问题、建议下一步。
3. 不要编造内容；无法确认的内容放入开放问题。
4. 保留来源线索，引用输入里的 node title 或 source id。
5. 控制在 1200 字以内。
"""


def topic_memory_node_id(user_id: str, topic: str, level: str = "topic") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:48] or "topic"
    digest = hashlib.sha1(f"{user_id}:{level}:{topic}".encode("utf-8")).hexdigest()[:10]
    return f"mem-topic-{slug}-{digest}"


async def compile_topic_memory_node(
    session: AsyncSession,
    *,
    user_id: str,
    topic: str,
    level: str = "topic",
    source_node_ids: list[str] | None = None,
    limit: int = 20,
) -> MemoryNode:
    seeds = await _load_seed_nodes(
        session,
        user_id=user_id,
        topic=topic,
        source_node_ids=source_node_ids,
        limit=limit,
    )
    if not seeds:
        raise ValueError("No memory nodes available to compile this topic")

    content = await _summarize_topic(topic, seeds)
    summary = _first_non_empty_line(content)
    node_id = topic_memory_node_id(user_id, topic, level)
    derived_note_ids = _merge_unique([note_id for seed in seeds for note_id in seed.derived_from_notes])
    derived_source_ids = _merge_unique([source_id for seed in seeds for source_id in seed.derived_from_sources])
    child_node_ids = [seed.id for seed in seeds]
    metadata = {
        "topic": topic,
        "source": "topic_memory_v1",
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "seed_node_count": len(seeds),
        "seed_node_types": _merge_unique([seed.node_type for seed in seeds]),
    }

    existing = await session.get(MemoryNode, node_id)
    if existing:
        existing.title = f"Topic Memory - {topic}"
        existing.summary = summary
        existing.content = content
        existing.child_node_ids = child_node_ids
        existing.derived_from_notes = derived_note_ids
        existing.derived_from_sources = derived_source_ids
        existing.derived_from_chunks = _merge_unique_int(
            [chunk_id for seed in seeds for chunk_id in seed.derived_from_chunks]
        )
        existing.metadata_ = metadata
        node = existing
    else:
        node = MemoryNode(
            id=node_id,
            user_id=user_id,
            node_type="topic",
            scope_id=_topic_scope_id(topic),
            level=level,
            title=f"Topic Memory - {topic}",
            summary=summary,
            content=content,
            child_node_ids=child_node_ids,
            derived_from_notes=derived_note_ids,
            derived_from_sources=derived_source_ids,
            derived_from_chunks=_merge_unique_int(
                [chunk_id for seed in seeds for chunk_id in seed.derived_from_chunks]
            ),
            metadata_=metadata,
            confidence_score=None,
        )
        session.add(node)

    await upsert_memory_embedding(session, node)
    await sync_memory_edges_for_node(session, node)
    await suggest_wiki_recompile_for_trigger(
        session,
        user_id=user_id,
        trigger_type="memory",
        trigger_id=node.id,
    )
    return node


async def preview_topic_memory_candidates(
    session: AsyncSession,
    *,
    user_id: str,
    topic: str,
    limit: int = 20,
) -> list[tuple[MemoryNode, str]]:
    candidates = await _load_semantic_seed_candidates(
        session,
        user_id=user_id,
        topic=topic,
        limit=limit,
    )
    if candidates:
        return candidates

    seeds = await _load_keyword_seed_nodes(
        session,
        user_id=user_id,
        topic=topic,
        limit=limit,
    )
    return [(seed, _candidate_reason(seed, topic)) for seed in seeds]


async def upsert_memory_embedding(session: AsyncSession, node: MemoryNode) -> None:
    node_id = node.id
    await session.flush([node])
    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(node.title)
        summary_vec = await emb_svc.embed_text(node.summary or node.title)
        content_vec = await emb_svc.embed_text(node.content or node.summary or node.title)
        with session.no_autoflush:
            existing = await session.get(MemoryEmbedding, node_id)
        if existing:
            existing.title_vec = title_vec
            existing.summary_vec = summary_vec
            existing.content_vec = content_vec
        else:
            session.add(
                MemoryEmbedding(
                    memory_node_id=node_id,
                    title_vec=title_vec,
                    summary_vec=summary_vec,
                    content_vec=content_vec,
                )
            )
    except Exception:
        logger.exception("Memory embedding generation failed for node %s", node_id)


async def _load_seed_nodes(
    session: AsyncSession,
    *,
    user_id: str,
    topic: str,
    source_node_ids: list[str] | None,
    limit: int,
) -> list[MemoryNode]:
    stmt = select(MemoryNode).where(MemoryNode.user_id == user_id)
    if source_node_ids:
        stmt = stmt.where(MemoryNode.id.in_(source_node_ids))
        stmt = stmt.order_by(MemoryNode.updated_at.desc()).limit(limit)
        rows = await session.execute(stmt)
        return list(rows.scalars())

    semantic_candidates = await _load_semantic_seed_candidates(
        session,
        user_id=user_id,
        topic=topic,
        limit=limit,
    )
    if semantic_candidates:
        return [node for node, _reason in semantic_candidates]

    return await _load_keyword_seed_nodes(session, user_id=user_id, topic=topic, limit=limit)


async def _load_keyword_seed_nodes(
    session: AsyncSession,
    *,
    user_id: str,
    topic: str,
    limit: int,
) -> list[MemoryNode]:
    like_pattern = f"%{_escape_like(topic)}%"
    stmt = (
        select(MemoryNode)
        .where(
            MemoryNode.user_id == user_id,
            MemoryNode.node_type.in_(["source", "global", "topic"]),
            or_(
                MemoryNode.title.ilike(like_pattern),
                MemoryNode.summary.ilike(like_pattern),
                MemoryNode.content.ilike(like_pattern),
            ),
        )
        .order_by(MemoryNode.updated_at.desc())
        .limit(limit)
    )
    rows = await session.execute(stmt)
    return list(rows.scalars())


async def _load_semantic_seed_candidates(
    session: AsyncSession,
    *,
    user_id: str,
    topic: str,
    limit: int,
) -> list[tuple[MemoryNode, str]]:
    try:
        emb_svc = get_embedding_service()
        query_vec = await emb_svc.embed_text(topic)
        query_vec_literal = "[" + ",".join(f"{value:.8f}" for value in query_vec) + "]"
        stmt = text("""
            SELECT m.id, 1 - (me.content_vec <=> CAST(:query_vec AS vector)) AS score
            FROM memory_embeddings me
            JOIN memory_nodes m ON m.id = me.memory_node_id
            WHERE m.user_id = :user_id
              AND m.node_type IN ('source', 'global', 'topic')
            ORDER BY me.content_vec <=> CAST(:query_vec AS vector)
            LIMIT :limit
        """)
        rows = await session.execute(stmt, {"query_vec": query_vec_literal, "user_id": user_id, "limit": limit})
        scored_ids = [(row.id, float(row.score)) for row in rows]
        if not scored_ids:
            return []

        nodes_by_id = await _load_nodes_by_id(session, [node_id for node_id, _score in scored_ids])
        candidates: list[tuple[MemoryNode, str]] = []
        for node_id, score in scored_ids:
            node = nodes_by_id.get(node_id)
            if node:
                candidates.append((node, f"Semantic memory match · score {score:.3f}"))
        return candidates
    except Exception:
        logger.exception("Semantic topic seed candidate search failed for %s", topic)
        return []


async def _load_nodes_by_id(session: AsyncSession, node_ids: list[str]) -> dict[str, MemoryNode]:
    rows = await session.execute(select(MemoryNode).where(MemoryNode.id.in_(node_ids)))
    nodes = list(rows.scalars())
    return {node.id: node for node in nodes}


async def _summarize_topic(topic: str, seeds: list[MemoryNode]) -> str:
    seed_text = "\n\n".join(
        f"## {seed.title}\nnode_id: {seed.id}\nnode_type: {seed.node_type}\n"
        f"sources: {', '.join(seed.derived_from_sources or [])}\n\n{seed.content[:3000]}"
        for seed in seeds
    )

    from pkg.services.llm import create_async_client

    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _TOPIC_PROMPT},
                {"role": "user", "content": f"主题：{topic}\n\n输入 memory nodes：\n{seed_text[:24000]}"},
            ],
        )
        content = response.choices[0].message.content or ""
        if content.strip():
            return content
    except Exception:
        logger.exception("LLM topic memory compilation failed for %s", topic)

    return _fallback_topic_summary(topic, seeds)


def _fallback_topic_summary(topic: str, seeds: list[MemoryNode]) -> str:
    sections = [f"# Topic Memory - {topic}", "", "## 主题概览", "LLM 编译失败，以下为相关 memory nodes 摘录。", ""]
    for seed in seeds[:10]:
        sections.extend([
            f"## {seed.title}",
            f"- node_id: {seed.id}",
            f"- node_type: {seed.node_type}",
            f"- sources: {', '.join(seed.derived_from_sources or []) or 'none'}",
            "",
            (seed.summary or seed.content or "")[:800],
            "",
        ])
    return "\n".join(sections).strip()


def _topic_scope_id(topic: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:80]
    return slug or "topic"


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _first_non_empty_line(value: str) -> str:
    for line in value.splitlines():
        cleaned = line.strip().lstrip("# ").strip()
        if cleaned:
            return cleaned[:500]
    return "Topic memory"


def _merge_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged


def _merge_unique_int(values: list[int]) -> list[int]:
    seen: set[int] = set()
    merged: list[int] = []
    for value in values:
        if value is not None and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged


def _candidate_reason(node: MemoryNode, topic: str) -> str:
    topic_lower = topic.lower()
    if topic_lower and topic_lower in (node.title or "").lower():
        return "Topic matched node title"
    if topic_lower and topic_lower in (node.summary or "").lower():
        return "Topic matched node summary"
    if topic_lower and topic_lower in (node.content or "").lower():
        return "Topic matched node content"
    return f"Recent {node.node_type}/{node.level} memory candidate"
