from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from pkg.models.memory import MemoryNode
from pkg.models.wiki import WikiPageMemory
from pkg.services.foundation.memory_edges import sync_memory_edges_for_node


@pytest.mark.asyncio
async def test_sync_memory_edges_mirrors_memory_arrays(mock_session):
    node = MemoryNode(
        id="mem-topic-ai",
        user_id="user-1",
        node_type="topic",
        scope_id="ai",
        level="topic",
        title="Topic Memory - AI",
        summary="summary",
        content="content",
        child_node_ids=["mem-source-1"],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        derived_from_chunks=[7],
        metadata_={},
        confidence_score=0.8,
    )
    empty_edge_lookup = MagicMock()
    empty_edge_lookup.scalar_one_or_none.return_value = None
    wiki_memory_lookup = MagicMock()
    wiki_memory_lookup.scalars.return_value = [
        WikiPageMemory(
            id=1,
            wiki_id="wiki-1",
            memory_node_id=node.id,
            relevance_summary="Supports wiki",
            key_points=[],
            supporting_claims=[],
            confidence_score=0.7,
            last_refreshed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
    ]
    mock_session.execute.side_effect = [empty_edge_lookup, empty_edge_lookup, empty_edge_lookup, empty_edge_lookup, wiki_memory_lookup, empty_edge_lookup]

    edges = await sync_memory_edges_for_node(mock_session, node)

    assert len(edges) == 5
    assert {edge.to_kind for edge in edges} == {"memory_node", "source", "note", "source_chunk", "wiki_page"}
    assert {edge.edge_type for edge in edges} == {"derived_from", "supports"}
    assert mock_session.add.call_count == 5
