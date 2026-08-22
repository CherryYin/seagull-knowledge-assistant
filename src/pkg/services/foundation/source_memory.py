"""Source Memory Tree v1 — creates one source-level MemoryNode per Source.

This is the first source tree layer: Source -> MemoryNode(node_type=source,
level=source). Later versions can add chunk_group / section levels.
"""
import hashlib
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.source import Source
from pkg.models.memory_edge import MemoryEdge
from pkg.services.foundation.memory_tree import upsert_memory_embedding
from pkg.services.foundation.memory_edges import sync_memory_edges_for_node
from pkg.services.foundation.wiki_recompile import suggest_wiki_recompile_for_trigger

logger = logging.getLogger(__name__)

_SOURCE_MEMORY_PROMPT = """\
你是个人知识图谱的 Source Memory 编译器。请把下面的 source 内容总结为一个可长期复用的 source-level memory。

要求：
1. 输出 Markdown。
2. 包含：核心摘要、关键观点、可复用事实、可能关联的主题、限制或待验证点。
3. 不要编造内容；只总结输入中出现的信息。
4. 控制在 800 字以内。
"""

_SOURCE_BATCH_MEMORY_PROMPT = """\
你是个人知识图谱的 Source Batch Memory 编译器。输入是一组短 source，它们每条内容较少，不值得单独生成 memory。

要求：
1. 输出 Markdown。
2. 包含：批次概览、高频主题、可复用事实或观点、低价值/噪声项、值得后续单独展开的 source。
3. 不要编造内容；只总结输入中出现的信息。
4. 保留 source id/title 线索，方便追溯证据。
5. 控制在 1200 字以内。
"""


def source_memory_node_id(source_id: str) -> str:
    return f"mem-source-{source_id}"


async def maybe_upsert_source_memory_node(
    session: AsyncSession,
    source: Source,
) -> MemoryNode | None:
    """Create Source Memory only when legacy automatic generation is enabled."""
    if not settings.SOURCE_MEMORY_AUTO_GENERATE_ENABLED:
        logger.info("Skipping automatic source memory generation for %s", source.id)
        return None
    return await upsert_source_memory_node(session, source)


async def delete_source_memory_derivatives(
    session: AsyncSession,
    *,
    user_id: str,
    source_id: str,
) -> dict[str, int]:
    """Remove source-level memory data and stale references for a deleted Source."""
    node_id = source_memory_node_id(source_id)
    node = await session.get(MemoryNode, node_id)
    deleted_nodes = 0

    if node is not None and node.user_id == user_id:
        await session.execute(
            delete(MemoryEdge).where(
                MemoryEdge.user_id == user_id,
                MemoryEdge.to_kind == "memory",
                MemoryEdge.to_id == node_id,
            )
        )
        await session.delete(node)
        deleted_nodes = 1

    rows = await session.execute(
        select(MemoryNode).where(
            MemoryNode.user_id == user_id,
            MemoryNode.id != node_id,
        )
    )
    updated_nodes = 0
    for related_node in rows.scalars():
        derived_from_sources = list(related_node.derived_from_sources or [])
        child_node_ids = list(related_node.child_node_ids or [])
        next_sources = [item for item in derived_from_sources if item != source_id]
        next_children = [item for item in child_node_ids if item != node_id]
        if next_sources != derived_from_sources or next_children != child_node_ids:
            related_node.derived_from_sources = next_sources
            related_node.child_node_ids = next_children
            updated_nodes += 1

    return {"deleted_nodes": deleted_nodes, "updated_nodes": updated_nodes}


def source_batch_memory_node_id(user_id: str, group_key: str, source_ids: list[str]) -> str:
    digest_input = "|".join([user_id, group_key, *sorted(source_ids)])
    digest = hashlib.sha1(digest_input.encode("utf-8")).hexdigest()[:12]
    slug = re.sub(r"[^a-z0-9]+", "-", group_key.lower()).strip("-")[:48] or "batch"
    return f"mem-source-batch-{slug}-{digest}"


async def upsert_source_batch_memory_node(
    session: AsyncSession,
    *,
    user_id: str,
    group_key: str,
    sources: list[Source],
) -> MemoryNode | None:
    """Create or update a batch memory node for multiple short sources."""
    if not user_id:
        logger.info("Skipping source batch memory without user_id: group=%s", group_key)
        return None
    valid_sources = [source for source in sources if source.id]
    if not valid_sources:
        return None

    source_ids = [source.id for source in valid_sources]
    node_id = source_batch_memory_node_id(user_id, group_key, source_ids)
    existing = await session.get(MemoryNode, node_id)
    summary_content = await _summarize_source_batch(group_key, valid_sources)
    metadata = {
        "source": "source_batch_memory_v1",
        "group_key": group_key,
        "source_count": len(valid_sources),
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "source_types": _merge_unique([source.source_type for source in valid_sources]),
        "urls": [source.url for source in valid_sources if source.url][:20],
    }

    if existing:
        existing.title = f"Source Batch Memory - {group_key}"
        existing.summary = _first_non_empty_line(summary_content)
        existing.content = summary_content
        existing.derived_from_sources = source_ids
        existing.metadata_ = metadata
        await upsert_memory_embedding(session, existing)
        await sync_memory_edges_for_node(session, existing)
        for source in valid_sources:
            await suggest_wiki_recompile_for_trigger(
                session,
                user_id=user_id,
                trigger_type="source",
                trigger_id=source.id,
            )
        return existing

    node = MemoryNode(
        id=node_id,
        user_id=user_id,
        node_type="source",
        scope_id=f"batch:{group_key}:{node_id[-12:]}",
        level="batch",
        title=f"Source Batch Memory - {group_key}",
        summary=_first_non_empty_line(summary_content),
        content=summary_content,
        child_node_ids=[],
        derived_from_notes=[],
        derived_from_sources=source_ids,
        derived_from_chunks=[],
        metadata_=metadata,
        confidence_score=None,
    )
    session.add(node)
    await upsert_memory_embedding(session, node)
    await sync_memory_edges_for_node(session, node)
    for source in valid_sources:
        await suggest_wiki_recompile_for_trigger(
            session,
            user_id=user_id,
            trigger_type="source",
            trigger_id=source.id,
        )
    return node


async def upsert_source_memory_node(session: AsyncSession, source: Source) -> MemoryNode | None:
    """Create or update the source-level memory node for a Source.

    The function is best-effort for summarization: LLM failures fall back to a
    deterministic excerpt-based summary so ingestion can continue.
    """
    if not source.user_id:
        logger.info("Skipping source memory for source %s without user_id", source.id)
        return None

    content = _source_memory_input(source)
    summary_content = await _summarize_source(source.title, content)
    node_id = source_memory_node_id(source.id)
    existing = await session.get(MemoryNode, node_id)

    metadata = {
        "source_id": source.id,
        "source_type": source.source_type,
        "url": source.url,
        "content_hash": source.content_hash,
        "source": "source_memory_v1",
    }
    memory_input_strategy = _source_memory_input_strategy(source)
    if memory_input_strategy:
        metadata["memory_input_strategy"] = memory_input_strategy

    if existing:
        existing.title = f"Source Memory - {source.title}"
        existing.summary = _first_non_empty_line(summary_content)
        existing.content = summary_content
        existing.derived_from_sources = [source.id]
        existing.metadata_ = metadata
        await upsert_memory_embedding(session, existing)
        await sync_memory_edges_for_node(session, existing)
        await suggest_wiki_recompile_for_trigger(
            session,
            user_id=source.user_id,
            trigger_type="source",
            trigger_id=source.id,
        )
        return existing

    node = MemoryNode(
        id=node_id,
        user_id=source.user_id,
        node_type="source",
        scope_id=source.id,
        level="source",
        title=f"Source Memory - {source.title}",
        summary=_first_non_empty_line(summary_content),
        content=summary_content,
        child_node_ids=[],
        derived_from_notes=[],
        derived_from_sources=[source.id],
        derived_from_chunks=[],
        metadata_=metadata,
        confidence_score=None,
    )
    session.add(node)
    await upsert_memory_embedding(session, node)
    await sync_memory_edges_for_node(session, node)
    await suggest_wiki_recompile_for_trigger(
        session,
        user_id=source.user_id,
        trigger_type="source",
        trigger_id=source.id,
    )
    return node


async def _summarize_source(title: str, content: str) -> str:
    if not content:
        return f"# {title}\n\n## 核心摘要\n\n该 source 暂无可总结的正文内容。"

    from pkg.services.cross_cutting.llm import create_async_client

    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SOURCE_MEMORY_PROMPT},
                {"role": "user", "content": f"标题：{title}\n\n内容：\n{content[:16000]}"},
            ],
        )
        summary = response.choices[0].message.content or ""
        if summary.strip():
            return summary
    except Exception:
        logger.exception("LLM source memory summarization failed for %s", title)

    return _fallback_summary(title, content)


def _source_memory_input(source: Source) -> str:
    metadata = source.metadata_ or {}
    embedding_text = metadata.get("embedding_text")
    if source.source_type == "github" and isinstance(embedding_text, str) and embedding_text.strip():
        return embedding_text.strip()
    return (source.raw_content or "").strip()


def _source_memory_input_strategy(source: Source) -> str | None:
    metadata = source.metadata_ or {}
    strategy = metadata.get("embedding_strategy")
    if source.source_type == "github" and isinstance(strategy, str) and strategy.strip():
        return strategy.strip()
    return None


async def _summarize_source_batch(group_key: str, sources: list[Source]) -> str:
    source_text = "\n\n".join(
        f"## {source.title}\nsource_id: {source.id}\nsource_type: {source.source_type}\n"
        f"url: {source.url or 'N/A'}\n\n{(source.raw_content or '').strip()[:1200]}"
        for source in sources
    )
    if not source_text.strip():
        return f"# Source Batch Memory - {group_key}\n\n## 批次概览\n\n该批次 source 暂无可总结的正文内容。"

    from pkg.services.cross_cutting.llm import create_async_client

    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SOURCE_BATCH_MEMORY_PROMPT},
                {"role": "user", "content": f"批次：{group_key}\n\n短 source 列表：\n{source_text[:24000]}"},
            ],
        )
        summary = response.choices[0].message.content or ""
        if summary.strip():
            return summary
    except Exception:
        logger.exception("LLM source batch memory summarization failed for %s", group_key)

    return _fallback_batch_summary(group_key, sources)


def _fallback_summary(title: str, content: str) -> str:
    excerpt = content[:4000].strip()
    return (
        f"# {title}\n\n"
        "## 核心摘要\n\n"
        "LLM 摘要生成失败，以下为 source 内容摘录，供后续重新编译。\n\n"
        "## 内容摘录\n\n"
        f"{excerpt}"
    )


def _fallback_batch_summary(group_key: str, sources: list[Source]) -> str:
    sections = [
        f"# Source Batch Memory - {group_key}",
        "",
        "## 批次概览",
        "LLM 批量摘要生成失败，以下为短 source 摘录，供后续重新编译。",
        "",
    ]
    for source in sources[:30]:
        excerpt = (source.raw_content or "").strip()[:500]
        sections.extend([
            f"## {source.title}",
            f"- source_id: {source.id}",
            f"- source_type: {source.source_type}",
            f"- url: {source.url or 'N/A'}",
            "",
            excerpt or "该 source 暂无正文内容。",
            "",
        ])
    return "\n".join(sections).strip()


def _first_non_empty_line(value: str) -> str:
    for line in value.splitlines():
        cleaned = line.strip().lstrip("# ").strip()
        if cleaned:
            return cleaned[:500]
    return "Source memory"


def _merge_unique(values: list[str | None]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged
