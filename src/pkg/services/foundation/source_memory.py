"""Cleanup helpers for historical Source-derived MemoryNode records."""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.memory import MemoryNode
from pkg.models.memory_edge import MemoryEdge


def source_memory_node_id(source_id: str) -> str:
    return f"mem-source-{source_id}"


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
