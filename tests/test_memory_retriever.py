from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.memory_retriever import format_memory_context, retrieve_for_query


@pytest.mark.asyncio
async def test_retrieve_for_query_merges_semantic_and_keyword_results():
    semantic_node = MagicMock()
    semantic_node.id = "mem-sem"
    semantic_node.title = "Semantic Memory"
    semantic_node.summary = "Semantic summary"
    semantic_node.content = "Semantic content"
    semantic_node.node_type = "topic"
    semantic_node.level = "topic"
    semantic_node.confidence_score = 0.8

    keyword_node = MagicMock()
    keyword_node.id = "mem-key"
    keyword_node.title = "Keyword Memory"
    keyword_node.summary = "Keyword summary"
    keyword_node.content = "Keyword content"
    keyword_node.node_type = "source"
    keyword_node.level = "document"
    keyword_node.confidence_score = 0.6

    session = AsyncMock()

    semantic_rows = [MagicMock(id="mem-sem", score=0.9)]
    keyword_scalars = MagicMock()
    keyword_scalars.scalars.return_value = [keyword_node]
    session.execute.side_effect = [semantic_rows, MagicMock(scalars=MagicMock(return_value=[semantic_node])), keyword_scalars]

    with patch("pkg.services.foundation.memory_retriever.get_embedding_service") as mock_embedding:
        mock_embedding.return_value.embed_text = AsyncMock(return_value=[0.1, 0.2])
        results = await retrieve_for_query(session, user_id="user-1", query="memory topic", limit=5)

    assert [result.node.id for result in results] == ["mem-sem", "mem-key"]
    assert results[0].matched_reason.startswith("semantic match")


def test_format_memory_context_is_compact_and_traceable():
    node = MagicMock()
    node.id = "mem-1"
    node.title = "Memory One"
    node.summary = "A" * 1000
    node.content = "Fallback"
    node.node_type = "topic"
    node.level = "topic"
    node.confidence_score = 0.7
    result = MagicMock(node=node, matched_reason="keyword match", score=0.5)

    text = format_memory_context([result], max_chars_per_item=40)

    assert "Relevant long-term memory" in text
    assert "mem-1" in text
    assert "Memory One" in text
    assert "…" in text
