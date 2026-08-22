from collections import Counter
from typing import Any

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.memory import MemoryEmbedding, MemoryNode
from pkg.models.foundation.source import Source
from pkg.models.memory_edge import MemoryEdge


async def _load_orphan_records(session: AsyncSession) -> list[tuple[str, str, str, dict | None]]:
    rows = await session.execute(
        select(
            MemoryNode.id,
            MemoryNode.user_id,
            MemoryNode.scope_id,
            MemoryNode.metadata_,
        )
        .outerjoin(
            Source,
            and_(
                Source.id == MemoryNode.scope_id,
                Source.user_id == MemoryNode.user_id,
            ),
        )
        .where(
            MemoryNode.node_type == "source",
            MemoryNode.level == "source",
            Source.id.is_(None),
        )
        .order_by(MemoryNode.id)
    )
    return list(rows.all())


async def _count(session: AsyncSession, statement) -> int:
    rows = await session.execute(statement)
    return int(rows.scalar_one_or_none() or 0)


async def _collect_impact(
    session: AsyncSession,
    records: list[tuple[str, str, str, dict | None]],
    *,
    id_limit: int,
) -> dict[str, Any]:
    node_ids = [record[0] for record in records]
    source_ids = [record[2] for record in records]
    if not node_ids:
        return {
            "orphan_nodes": 0,
            "ids": [],
            "ids_truncated": False,
            "by_source_type": {},
            "by_user": {},
            "incoming_edges": 0,
            "outgoing_edges": 0,
            "embeddings": 0,
            "referencing_nodes": 0,
            "source_references": 0,
            "child_references": 0,
        }

    incoming_edges = await _count(
        session,
        select(func.count()).select_from(MemoryEdge).where(
            MemoryEdge.to_kind == "memory",
            MemoryEdge.to_id.in_(node_ids),
        ),
    )
    outgoing_edges = await _count(
        session,
        select(func.count()).select_from(MemoryEdge).where(MemoryEdge.from_node_id.in_(node_ids)),
    )
    embeddings = await _count(
        session,
        select(func.count()).select_from(MemoryEmbedding).where(MemoryEmbedding.memory_node_id.in_(node_ids)),
    )
    reference_rows = await session.execute(
        select(
            MemoryNode.id,
            MemoryNode.derived_from_sources,
            MemoryNode.child_node_ids,
        ).where(MemoryNode.id.notin_(node_ids))
    )

    source_id_set = set(source_ids)
    node_id_set = set(node_ids)
    referencing_nodes = 0
    source_references = 0
    child_references = 0
    for _node_id, derived_from_sources, child_node_ids in reference_rows.all():
        matched_sources = sum(1 for item in (derived_from_sources or []) if item in source_id_set)
        matched_children = sum(1 for item in (child_node_ids or []) if item in node_id_set)
        if matched_sources or matched_children:
            referencing_nodes += 1
            source_references += matched_sources
            child_references += matched_children

    source_types = Counter(
        str((record[3] or {}).get("source_type") or "unknown")
        for record in records
    )
    users = Counter(record[1] for record in records)
    return {
        "orphan_nodes": len(node_ids),
        "ids": node_ids[:id_limit],
        "ids_truncated": len(node_ids) > id_limit,
        "by_source_type": dict(sorted(source_types.items())),
        "by_user": dict(sorted(users.items())),
        "incoming_edges": incoming_edges,
        "outgoing_edges": outgoing_edges,
        "embeddings": embeddings,
        "referencing_nodes": referencing_nodes,
        "source_references": source_references,
        "child_references": child_references,
    }


async def audit_orphan_source_memory_cleanup(
    session: AsyncSession,
    *,
    id_limit: int = 1000,
) -> dict[str, Any]:
    if id_limit < 0:
        raise ValueError("id_limit must be non-negative")
    records = await _load_orphan_records(session)
    return await _collect_impact(session, records, id_limit=id_limit)


async def cleanup_orphan_source_memory(session: AsyncSession) -> dict[str, Any]:
    records = await _load_orphan_records(session)
    impact = await _collect_impact(session, records, id_limit=0)
    node_ids = [record[0] for record in records]
    source_ids = [record[2] for record in records]
    if not node_ids:
        return {
            **impact,
            "orphan_nodes_deleted": 0,
            "incoming_edges_deleted": 0,
            "referencing_nodes_updated": 0,
            "source_references_removed": 0,
            "child_references_removed": 0,
        }

    incoming_result = await session.execute(
        delete(MemoryEdge).where(
            MemoryEdge.to_kind == "memory",
            MemoryEdge.to_id.in_(node_ids),
        )
    )
    related_rows = await session.execute(
        select(MemoryNode).where(
            MemoryNode.id.notin_(node_ids),
            or_(
                MemoryNode.derived_from_sources.overlap(source_ids),
                MemoryNode.child_node_ids.overlap(node_ids),
            ),
        )
    )
    source_id_set = set(source_ids)
    node_id_set = set(node_ids)
    referencing_nodes_updated = 0
    source_references_removed = 0
    child_references_removed = 0
    for node in related_rows.scalars():
        previous_sources = list(node.derived_from_sources or [])
        previous_children = list(node.child_node_ids or [])
        node.derived_from_sources = [item for item in previous_sources if item not in source_id_set]
        node.child_node_ids = [item for item in previous_children if item not in node_id_set]
        removed_sources = len(previous_sources) - len(node.derived_from_sources)
        removed_children = len(previous_children) - len(node.child_node_ids)
        if removed_sources or removed_children:
            referencing_nodes_updated += 1
            source_references_removed += removed_sources
            child_references_removed += removed_children

    node_result = await session.execute(delete(MemoryNode).where(MemoryNode.id.in_(node_ids)))
    await session.commit()
    return {
        **impact,
        "orphan_nodes_deleted": node_result.rowcount or 0,
        "incoming_edges_deleted": incoming_result.rowcount or 0,
        "referencing_nodes_updated": referencing_nodes_updated,
        "source_references_removed": source_references_removed,
        "child_references_removed": child_references_removed,
    }
