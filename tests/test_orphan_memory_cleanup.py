from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.services.cross_cutting.orphan_memory_cleanup import (
    audit_orphan_source_memory_cleanup,
    cleanup_orphan_source_memory,
)


def _rows(*, all_items=None, scalar=None, scalar_items=None, rowcount=0):
    rows = MagicMock()
    rows.all.return_value = all_items or []
    rows.scalar_one_or_none.return_value = scalar
    rows.scalars.return_value = scalar_items or []
    rows.rowcount = rowcount
    return rows


@pytest.mark.asyncio
async def test_audit_orphan_source_memory_cleanup_reports_full_impact():
    session = AsyncMock()
    session.execute.side_effect = [
        _rows(all_items=[
            ("mem-source-a", "user-1", "source-a", {"source_type": "web"}),
            ("mem-source-b", "user-1", "source-b", {"source_type": "github"}),
        ]),
        _rows(scalar=3),
        _rows(scalar=4),
        _rows(scalar=2),
        _rows(all_items=[
            ("mem-topic", ["source-a", "source-live"], ["mem-source-b"]),
            ("mem-other", ["source-live"], []),
        ]),
    ]

    result = await audit_orphan_source_memory_cleanup(session, id_limit=1)

    assert result == {
        "orphan_nodes": 2,
        "ids": ["mem-source-a"],
        "ids_truncated": True,
        "by_source_type": {"github": 1, "web": 1},
        "by_user": {"user-1": 2},
        "incoming_edges": 3,
        "outgoing_edges": 4,
        "embeddings": 2,
        "referencing_nodes": 1,
        "source_references": 1,
        "child_references": 1,
    }


@pytest.mark.asyncio
async def test_cleanup_orphan_source_memory_deletes_derivatives_and_updates_references():
    session = AsyncMock()
    related_node = MagicMock(
        derived_from_sources=["source-a", "source-live"],
        child_node_ids=["mem-source-b", "mem-live"],
    )
    session.execute.side_effect = [
        _rows(all_items=[
            ("mem-source-a", "user-1", "source-a", {"source_type": "web"}),
            ("mem-source-b", "user-1", "source-b", {"source_type": "github"}),
        ]),
        _rows(scalar=3),
        _rows(scalar=4),
        _rows(scalar=2),
        _rows(all_items=[
            ("mem-topic", ["source-a", "source-live"], ["mem-source-b"]),
        ]),
        _rows(rowcount=3),
        _rows(scalar_items=[related_node]),
        _rows(rowcount=2),
    ]

    result = await cleanup_orphan_source_memory(session)

    assert result["orphan_nodes_deleted"] == 2
    assert result["incoming_edges_deleted"] == 3
    assert result["referencing_nodes_updated"] == 1
    assert result["source_references_removed"] == 1
    assert result["child_references_removed"] == 1
    assert related_node.derived_from_sources == ["source-live"]
    assert related_node.child_node_ids == ["mem-live"]
    session.commit.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_audit_orphan_source_memory_cleanup_rejects_negative_id_limit():
    with pytest.raises(ValueError, match="id_limit must be non-negative"):
        await audit_orphan_source_memory_cleanup(AsyncMock(), id_limit=-1)
