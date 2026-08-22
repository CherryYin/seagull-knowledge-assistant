from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.services.foundation.source_memory import delete_source_memory_derivatives, source_memory_node_id


@pytest.mark.asyncio
async def test_delete_source_memory_derivatives_removes_node_and_stale_references():
    source_node = MagicMock(user_id="user-1")
    related_node = MagicMock(
        derived_from_sources=["src-1", "src-2"],
        child_node_ids=[source_memory_node_id("src-1"), "mem-topic-2"],
    )
    untouched_node = MagicMock(derived_from_sources=["src-2"], child_node_ids=[])
    rows = MagicMock()
    rows.scalars.return_value = [related_node, untouched_node]
    session = AsyncMock()
    session.get.return_value = source_node
    session.execute.side_effect = [MagicMock(), rows]

    result = await delete_source_memory_derivatives(session, user_id="user-1", source_id="src-1")

    assert result == {"deleted_nodes": 1, "updated_nodes": 1}
    session.delete.assert_awaited_once_with(source_node)
    assert related_node.derived_from_sources == ["src-2"]
    assert related_node.child_node_ids == ["mem-topic-2"]
    assert untouched_node.derived_from_sources == ["src-2"]


@pytest.mark.asyncio
async def test_delete_source_memory_derivatives_keeps_node_owned_by_another_user():
    source_node = MagicMock(user_id="user-2")
    rows = MagicMock()
    rows.scalars.return_value = []
    session = AsyncMock()
    session.get.return_value = source_node
    session.execute.return_value = rows

    result = await delete_source_memory_derivatives(session, user_id="user-1", source_id="src-1")

    assert result == {"deleted_nodes": 0, "updated_nodes": 0}
    session.delete.assert_not_awaited()
