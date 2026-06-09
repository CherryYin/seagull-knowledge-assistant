from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.memory import MemoryNode
from pkg.services.foundation.memory_tree import (
    compile_topic_memory_node,
    preview_topic_memory_candidates,
    topic_memory_node_id,
    upsert_memory_embedding,
)


@pytest.mark.asyncio
@patch("pkg.services.foundation.memory_tree._load_semantic_seed_candidates", new_callable=AsyncMock, return_value=[])
@patch("pkg.services.foundation.memory_tree.suggest_wiki_recompile_for_trigger", new_callable=AsyncMock)
@patch("pkg.services.foundation.memory_tree.sync_memory_edges_for_node", new_callable=AsyncMock)
@patch("pkg.services.foundation.memory_tree.upsert_memory_embedding", new_callable=AsyncMock)
@patch("pkg.services.cross_cutting.llm.create_async_client")
async def test_compile_topic_memory_node_creates_topic_node(
    mock_llm_client, mock_embedding, mock_sync_edges, mock_suggest, _mock_semantic
):
    seed = MemoryNode(
        id="mem-source-src-1",
        user_id="user-1",
        node_type="source",
        scope_id="src-1",
        level="source",
        title="Source Memory - Memory Tree",
        summary="Memory tree source summary",
        content="Memory Tree connects source memory to topic memory.",
        child_node_ids=[],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        derived_from_chunks=[1],
        metadata_={},
        confidence_score=None,
    )

    scalars = MagicMock(return_value=[seed])
    execute_result = MagicMock()
    execute_result.scalars = scalars

    session = AsyncMock()
    session.execute = AsyncMock(return_value=execute_result)
    session.get = AsyncMock(return_value=None)
    session.add = MagicMock()

    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="# Topic Memory\n\nStable summary"))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)
    mock_llm_client.return_value = (client, "test-model")

    node = await compile_topic_memory_node(session, user_id="user-1", topic="Memory Tree")

    assert node.id == topic_memory_node_id("user-1", "Memory Tree")
    assert node.node_type == "topic"
    assert node.level == "topic"
    assert node.child_node_ids == ["mem-source-src-1"]
    assert node.derived_from_notes == ["note-1"]
    assert node.derived_from_sources == ["src-1"]
    assert node.derived_from_chunks == [1]
    session.add.assert_called_once_with(node)
    mock_embedding.assert_awaited_once_with(session, node)
    mock_sync_edges.assert_awaited_once_with(session, node)
    mock_suggest.assert_awaited_once_with(
        session,
        user_id="user-1",
        trigger_type="memory",
        trigger_id=node.id,
    )


@pytest.mark.asyncio
@patch("pkg.services.foundation.memory_tree._load_semantic_seed_candidates", new_callable=AsyncMock, return_value=[])
async def test_compile_topic_memory_node_requires_seed_nodes(_mock_semantic):
    execute_result = MagicMock()
    execute_result.scalars.return_value = []
    session = AsyncMock()
    session.execute = AsyncMock(return_value=execute_result)

    with pytest.raises(ValueError):
        await compile_topic_memory_node(session, user_id="user-1", topic="Missing")


@pytest.mark.asyncio
@patch("pkg.services.foundation.memory_tree._load_semantic_seed_candidates", new_callable=AsyncMock, return_value=[])
async def test_preview_topic_memory_candidates_returns_reasons(_mock_semantic):
    seed = MemoryNode(
        id="mem-source-src-1",
        user_id="user-1",
        node_type="source",
        scope_id="src-1",
        level="source",
        title="Source Memory - Memory Tree",
        summary="Memory tree source summary",
        content="Memory Tree connects source memory to topic memory.",
        child_node_ids=[],
        derived_from_notes=[],
        derived_from_sources=["src-1"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=None,
    )
    execute_result = MagicMock()
    execute_result.scalars.return_value = [seed]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=execute_result)

    candidates = await preview_topic_memory_candidates(session, user_id="user-1", topic="Memory Tree")

    assert candidates == [(seed, "Topic matched node title")]


@pytest.mark.asyncio
@patch("pkg.services.foundation.memory_tree.get_embedding_service")
async def test_preview_topic_memory_candidates_uses_semantic_search(mock_embedding_service):
    seed = MemoryNode(
        id="mem-source-src-1",
        user_id="user-1",
        node_type="source",
        scope_id="src-1",
        level="source",
        title="Source Memory - Coding Agent",
        summary="Agent coding tools",
        content="Codex and Claude Code workflows.",
        child_node_ids=[],
        derived_from_notes=[],
        derived_from_sources=["src-1"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=None,
    )
    emb = AsyncMock()
    emb.embed_text = AsyncMock(return_value=[0.1, 0.2])
    mock_embedding_service.return_value = emb

    semantic_row = MagicMock(id="mem-source-src-1", score=0.87)
    semantic_result = [semantic_row]
    node_result = MagicMock()
    node_result.scalars.return_value = [seed]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[semantic_result, node_result])

    candidates = await preview_topic_memory_candidates(session, user_id="user-1", topic="AI coding")

    assert candidates == [(seed, "Semantic memory match · score 0.870")]
    emb.embed_text.assert_awaited_once_with("AI coding")


@pytest.mark.asyncio
@patch("pkg.services.foundation.memory_tree.get_embedding_service")
async def test_upsert_memory_embedding_flushes_node_before_embedding(mock_embedding_service):
    node = MemoryNode(
        id="mem-source-src-1",
        user_id="user-1",
        node_type="source",
        scope_id="src-1",
        level="source",
        title="Source Memory - Test",
        summary="Summary",
        content="Content",
        child_node_ids=[],
        derived_from_notes=[],
        derived_from_sources=["src-1"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=None,
    )
    session = AsyncMock()
    session.flush = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.add = MagicMock()
    session.no_autoflush = MagicMock()
    session.no_autoflush.__enter__ = MagicMock(return_value=None)
    session.no_autoflush.__exit__ = MagicMock(return_value=None)
    emb = AsyncMock()
    emb.embed_text = AsyncMock(return_value=[0.1, 0.2])
    mock_embedding_service.return_value = emb

    await upsert_memory_embedding(session, node)

    session.flush.assert_awaited_once_with([node])
    session.add.assert_called_once()
