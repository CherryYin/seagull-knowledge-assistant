import hashlib
import re
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.agent_run import AgentRun, AgentRunEvent
from pkg.models.foundation.memory import MemoryNode
from pkg.services.foundation.memory_edges import load_memory_edges, upsert_memory_edge
from pkg.services.foundation.memory_lifecycle import record_memory_use
from pkg.services.foundation.memory_tree import upsert_memory_embedding
from pkg.services.foundation.memory_retriever import retrieve_for_query

AGENT_MEMORY_TOOL_SOURCE = "agent_memory_tools_v1"
AGENT_RUN_EXTRACTION_SOURCE = "agent_run_extraction_v1"
MEMORY_INTENT_RE = re.compile(r"(remember|记住|长期记忆|保存为记忆|create memory|conversation memory)", re.IGNORECASE)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean_text(value: str | None, max_chars: int = 1200) -> str:
    text = " ".join((value or "").split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _memory_id(prefix: str, user_id: str, seed: str) -> str:
    digest = hashlib.sha1(f"{user_id}:{seed}".encode("utf-8")).hexdigest()[:16]
    return f"mem-{prefix}-{user_id[:8]}-{digest}"


async def record_agent_memory_use(
    session: AsyncSession,
    *,
    user_id: str,
    run_id: str | None,
    memory_node_ids: list[str],
    action: str,
    query: str | None = None,
) -> None:
    if not run_id or not memory_node_ids:
        return

    unique_ids = list(dict.fromkeys(memory_node_ids))
    rows = await session.execute(select(MemoryNode).where(MemoryNode.user_id == user_id, MemoryNode.id.in_(unique_ids)))
    nodes = list(rows.scalars())
    if not nodes:
        return

    event = AgentRunEvent(
        run_id=run_id,
        user_id=user_id,
        event_type="memory_used",
        title=f"Memory used: {action}"[:200],
        detail=", ".join(node.title for node in nodes)[:1000],
        metadata_={"memory_node_ids": [node.id for node in nodes], "action": action, "query": query},
    )
    session.add(event)

    used_at = _utc_now().isoformat()
    for node in nodes:
        record_memory_use(node, used_at=used_at, action=action, query=query)

        await upsert_memory_edge(
            session,
            user_id=user_id,
            from_node_id=node.id,
            to_kind="agent_run",
            to_id=run_id,
            edge_type="mentions",
            weight=1.0,
            description=f"Agent run used this memory via {action}.",
            metadata={"source": AGENT_MEMORY_TOOL_SOURCE, "action": action, "query": query},
        )


async def search_memory_nodes(
    session: AsyncSession,
    *,
    user_id: str,
    query: str,
    node_type: str | None = None,
    level: str | None = None,
    limit: int = 5,
) -> list[MemoryNode]:
    """Backward-compatible wrapper around the Phase B memory retriever."""
    results = await retrieve_for_query(
        session,
        user_id=user_id,
        query=query,
        node_type=node_type,
        level=level,
        limit=limit,
    )
    return [result.node for result in results]


async def load_related_memory_nodes(
    session: AsyncSession,
    *,
    user_id: str,
    node_id: str,
    limit: int = 10,
) -> tuple[MemoryNode | None, list[MemoryNode]]:
    node = await session.get(MemoryNode, node_id)
    if not node or node.user_id != user_id:
        return None, []

    edges = await load_memory_edges(session, user_id=user_id, node_id=node_id, direction="both", limit=limit * 3)
    related_ids: list[str] = []
    for edge in edges:
        if edge.from_node_id != node_id:
            related_ids.append(edge.from_node_id)
        if edge.to_kind == "memory_node" and edge.to_id != node_id:
            related_ids.append(edge.to_id)
    related_ids = list(dict.fromkeys(related_ids))[:limit]
    if not related_ids:
        return node, []
    rows = await session.execute(select(MemoryNode).where(MemoryNode.user_id == user_id, MemoryNode.id.in_(related_ids)))
    nodes_by_id = {item.id: item for item in rows.scalars()}
    return node, [nodes_by_id[item_id] for item_id in related_ids if item_id in nodes_by_id]


async def create_pending_conversation_memory(
    session: AsyncSession,
    *,
    user_id: str,
    title: str,
    summary: str,
    content: str,
    run_id: str | None = None,
    confidence_score: float = 0.4,
    metadata: dict | None = None,
) -> MemoryNode:
    clean_title = _clean_text(title, 180) or "Conversation Memory"
    clean_summary = _clean_text(summary, 500) or clean_title
    clean_content = content.strip() or clean_summary
    node_id = _memory_id("conv", user_id, f"{run_id or ''}:{clean_title}:{clean_summary}")
    confidence_score = min(max(confidence_score, 0.0), 0.6)
    now = _utc_now().isoformat()
    memory_metadata = {
        "source": AGENT_MEMORY_TOOL_SOURCE,
        "status": "pending_review",
        "requires_review": True,
        "guardrail": "Agents may only create low-confidence pending-review memories.",
        "created_by_agent_run_id": run_id,
        "created_at": now,
        **(metadata or {}),
    }

    node = await session.get(MemoryNode, node_id)
    if node:
        node.title = clean_title
        node.summary = clean_summary
        node.content = clean_content
        node.metadata_ = {**(node.metadata_ or {}), **memory_metadata}
        node.confidence_score = confidence_score
    else:
        node = MemoryNode(
            id=node_id,
            user_id=user_id,
            node_type="global",
            scope_id=f"conversation:{run_id or node_id}",
            level="conversation",
            title=clean_title,
            summary=clean_summary,
            content=clean_content,
            child_node_ids=[],
            derived_from_notes=[],
            derived_from_sources=[],
            derived_from_chunks=[],
            metadata_=memory_metadata,
            confidence_score=confidence_score,
        )
        session.add(node)

    await upsert_memory_embedding(session, node)
    if run_id:
        await upsert_memory_edge(
            session,
            user_id=user_id,
            from_node_id=node.id,
            to_kind="agent_run",
            to_id=run_id,
            edge_type="derived_from",
            weight=1.0,
            description="Pending conversation memory extracted from an agent run.",
            metadata={"source": AGENT_RUN_EXTRACTION_SOURCE, "requires_review": True},
        )
    return node


async def extract_pending_memory_from_agent_run(
    session: AsyncSession,
    *,
    run: AgentRun,
    result_preview: str | None,
) -> MemoryNode | None:
    combined = f"{run.task}\n{result_preview or ''}"
    if not MEMORY_INTENT_RE.search(combined):
        return None
    if len(_clean_text(result_preview, 5000)) < 80:
        return None

    return await create_pending_conversation_memory(
        session,
        user_id=run.user_id,
        title=f"Conversation Memory - {_clean_text(run.task, 80)}",
        summary=_clean_text(result_preview, 500),
        content=(
            f"# Agent Run Memory\n\n"
            f"Task: {run.task}\n\n"
            f"Result preview:\n{result_preview}\n"
        ),
        run_id=run.id,
        confidence_score=0.35,
        metadata={"source": AGENT_RUN_EXTRACTION_SOURCE, "agent_type": run.agent_type},
    )


async def create_memory_from_note(
    session: AsyncSession,
    *,
    user_id: str,
    note_id: str,
    memory_kind: str = "note",
    confidence_score: float = 0.65,
) -> MemoryNode | None:
    """Create or update an active memory node from a kept note/document.

    This is intentionally extractive: it stores a compact summary of the saved
    note/document rather than treating the whole note as one opaque memory.
    """
    from pkg.models.foundation.note import Note

    note = await session.get(Note, note_id)
    if not note or note.user_id != user_id:
        return None

    content = _clean_text(note.content or note.abstract or "", 1800)
    if not content:
        return None

    prefix = "digest" if note.note_type == "digest" else "doc" if "from-document" in (note.tags or []) else memory_kind
    node_id = _memory_id(prefix, user_id, note.id)
    title = f"{prefix.title()} Memory - {note.title}"[:200]
    summary = _clean_text(note.abstract or content, 500)
    memory_metadata = {
        "source": "note_memory_v1",
        "status": "active",
        "note_type": note.note_type,
        "created_from_note_id": note.id,
        "created_at": _utc_now().isoformat(),
    }

    node = await session.get(MemoryNode, node_id)
    if node:
        node.title = title
        node.summary = summary
        node.content = content
        node.derived_from_notes = [note.id]
        node.derived_from_sources = note.source_ids or []
        node.metadata_ = {**(node.metadata_ or {}), **memory_metadata}
        node.confidence_score = confidence_score
    else:
        node = MemoryNode(
            id=node_id,
            user_id=user_id,
            node_type="global" if prefix == "digest" else "source",
            scope_id=f"note:{note.id}",
            level="digest" if prefix == "digest" else "document",
            title=title,
            summary=summary,
            content=content,
            child_node_ids=[],
            derived_from_notes=[note.id],
            derived_from_sources=note.source_ids or [],
            derived_from_chunks=[],
            metadata_=memory_metadata,
            confidence_score=confidence_score,
        )
        session.add(node)

    await upsert_memory_embedding(session, node)
    await upsert_memory_edge(
        session,
        user_id=user_id,
        from_node_id=node.id,
        to_kind="note",
        to_id=note.id,
        edge_type="derived_from",
        weight=1.0,
        description="Memory created from a kept note or saved document.",
        metadata={"source": "note_memory_v1", "note_type": note.note_type},
    )
    return node
