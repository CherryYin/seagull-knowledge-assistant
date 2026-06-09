from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.memory import MemoryNode
from pkg.models.memory_edge import MemoryEdge
from pkg.models.foundation.wiki import WikiPageMemory

DERIVED_EDGE_SOURCE = "memory_mirror_v1"


async def upsert_memory_edge(
    session: AsyncSession,
    *,
    user_id: str,
    from_node_id: str,
    to_kind: str,
    to_id: str,
    edge_type: str,
    weight: float | None = None,
    description: str | None = None,
    metadata: dict | None = None,
) -> MemoryEdge:
    rows = await session.execute(
        select(MemoryEdge).where(
            MemoryEdge.from_node_id == from_node_id,
            MemoryEdge.to_kind == to_kind,
            MemoryEdge.to_id == to_id,
            MemoryEdge.edge_type == edge_type,
        )
    )
    edge = rows.scalar_one_or_none()
    if edge:
        edge.weight = weight
        edge.description = description
        edge.metadata_ = metadata
        return edge

    edge = MemoryEdge(
        user_id=user_id,
        from_node_id=from_node_id,
        to_kind=to_kind,
        to_id=to_id,
        edge_type=edge_type,
        weight=weight,
        description=description,
        metadata_=metadata,
    )
    session.add(edge)
    return edge


async def sync_memory_edges_for_node(session: AsyncSession, node: MemoryNode) -> list[MemoryEdge]:
    metadata = {"source": DERIVED_EDGE_SOURCE}
    edges: list[MemoryEdge] = []

    for child_node_id in node.child_node_ids or []:
        edges.append(await upsert_memory_edge(
            session,
            user_id=node.user_id,
            from_node_id=node.id,
            to_kind="memory_node",
            to_id=child_node_id,
            edge_type="derived_from",
            weight=1.0,
            description="Mirrored from memory child_node_ids.",
            metadata=metadata,
        ))

    for source_id in node.derived_from_sources or []:
        edges.append(await upsert_memory_edge(
            session,
            user_id=node.user_id,
            from_node_id=node.id,
            to_kind="source",
            to_id=source_id,
            edge_type="derived_from",
            weight=1.0,
            description="Mirrored from memory derived_from_sources.",
            metadata=metadata,
        ))

    for note_id in node.derived_from_notes or []:
        edges.append(await upsert_memory_edge(
            session,
            user_id=node.user_id,
            from_node_id=node.id,
            to_kind="note",
            to_id=note_id,
            edge_type="derived_from",
            weight=1.0,
            description="Mirrored from memory derived_from_notes.",
            metadata=metadata,
        ))

    for chunk_id in node.derived_from_chunks or []:
        edges.append(await upsert_memory_edge(
            session,
            user_id=node.user_id,
            from_node_id=node.id,
            to_kind="source_chunk",
            to_id=str(chunk_id),
            edge_type="derived_from",
            weight=1.0,
            description="Mirrored from memory derived_from_chunks.",
            metadata=metadata,
        ))

    wiki_rows = await session.execute(select(WikiPageMemory).where(WikiPageMemory.memory_node_id == node.id))
    for wiki_memory in wiki_rows.scalars():
        edges.append(await upsert_memory_edge(
            session,
            user_id=node.user_id,
            from_node_id=node.id,
            to_kind="wiki_page",
            to_id=wiki_memory.wiki_id,
            edge_type="supports",
            weight=wiki_memory.confidence_score,
            description=wiki_memory.relevance_summary,
            metadata={"source": "wiki_page_memory"},
        ))

    return edges


async def load_memory_edges(
    session: AsyncSession,
    *,
    user_id: str,
    node_id: str,
    direction: str = "both",
    limit: int = 200,
) -> list[MemoryEdge]:
    clauses = []
    if direction in {"out", "both"}:
        clauses.append(MemoryEdge.from_node_id == node_id)
    if direction in {"in", "both"}:
        clauses.append((MemoryEdge.to_kind == "memory_node") & (MemoryEdge.to_id == node_id))
    if not clauses:
        return []
    rows = await session.execute(
        select(MemoryEdge)
        .where(MemoryEdge.user_id == user_id, or_(*clauses))
        .order_by(MemoryEdge.updated_at.desc())
        .limit(limit)
    )
    return list(rows.scalars())
