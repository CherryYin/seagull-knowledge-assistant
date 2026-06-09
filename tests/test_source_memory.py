from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.source_memory import (
    source_batch_memory_node_id,
    source_memory_node_id,
    upsert_source_batch_memory_node,
    upsert_source_memory_node,
)


@pytest.mark.asyncio
@patch("pkg.services.foundation.source_memory.suggest_wiki_recompile_for_trigger", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.sync_memory_edges_for_node", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.upsert_memory_embedding", new_callable=AsyncMock)
@patch("pkg.services.cross_cutting.llm.create_async_client")
async def test_upsert_source_memory_node_creates_node(mock_llm_client, mock_embedding, mock_sync_edges, mock_suggest):
    source = _make_source()
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.add = MagicMock()

    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="# Source Summary\n\nKey points"))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)
    mock_llm_client.return_value = (client, "test-model")

    node = await upsert_source_memory_node(session, source)

    assert node is not None
    assert node.id == source_memory_node_id(source.id)
    assert node.node_type == "source"
    assert node.level == "source"
    assert node.scope_id == source.id
    assert node.derived_from_sources == [source.id]
    assert node.metadata_["content_hash"] == source.content_hash
    session.add.assert_called_once_with(node)
    mock_embedding.assert_awaited_once_with(session, node)
    mock_sync_edges.assert_awaited_once_with(session, node)
    mock_suggest.assert_awaited_once_with(
        session,
        user_id=source.user_id,
        trigger_type="memory",
        trigger_id=node.id,
    )


@pytest.mark.asyncio
@patch("pkg.services.foundation.source_memory.suggest_wiki_recompile_for_trigger", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.sync_memory_edges_for_node", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.upsert_memory_embedding", new_callable=AsyncMock)
@patch("pkg.services.cross_cutting.llm.create_async_client")
async def test_upsert_source_memory_node_fallback_on_llm_error(mock_llm_client, mock_embedding, mock_sync_edges, mock_suggest):
    source = _make_source()
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.add = MagicMock()
    mock_llm_client.side_effect = RuntimeError("llm unavailable")

    node = await upsert_source_memory_node(session, source)

    assert node is not None
    assert "内容摘录" in node.content
    assert "Source content" in node.content
    mock_embedding.assert_awaited_once_with(session, node)
    mock_sync_edges.assert_awaited_once_with(session, node)
    mock_suggest.assert_awaited_once()


@pytest.mark.asyncio
@patch("pkg.services.foundation.source_memory.suggest_wiki_recompile_for_trigger", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.sync_memory_edges_for_node", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.upsert_memory_embedding", new_callable=AsyncMock)
@patch("pkg.services.cross_cutting.llm.create_async_client")
async def test_github_source_memory_uses_repo_summary_input(mock_llm_client, mock_embedding, mock_sync_edges, mock_suggest):
    source = _make_source(source_id="src-github-openai-codex", title="openai/codex")
    source.source_type = "github"
    source.raw_content = "# README\n\nHuge README content that should not be summarized."
    source.metadata_ = {
        "embedding_strategy": "github_repo_summary_v1",
        "embedding_text": "GitHub repository: openai/codex\nLanguage: TypeScript\nTopics: agents",
    }
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.add = MagicMock()

    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="# GitHub Summary\n\nRepo metadata summary"))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)
    mock_llm_client.return_value = (client, "test-model")

    node = await upsert_source_memory_node(session, source)

    user_message = client.chat.completions.create.await_args.kwargs["messages"][1]["content"]
    assert "GitHub repository: openai/codex" in user_message
    assert "Huge README content" not in user_message
    assert node.metadata_["memory_input_strategy"] == "github_repo_summary_v1"
    mock_embedding.assert_awaited_once_with(session, node)
    mock_sync_edges.assert_awaited_once_with(session, node)
    mock_suggest.assert_awaited_once()


@pytest.mark.asyncio
@patch("pkg.services.foundation.source_memory.suggest_wiki_recompile_for_trigger", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.sync_memory_edges_for_node", new_callable=AsyncMock)
@patch("pkg.services.foundation.source_memory.upsert_memory_embedding", new_callable=AsyncMock)
@patch("pkg.services.cross_cutting.llm.create_async_client")
async def test_upsert_source_batch_memory_node_creates_batch(mock_llm_client, mock_embedding, mock_sync_edges, mock_suggest):
    sources = [_make_source(source_id="src-1"), _make_source(source_id="src-2", title="Second Source")]
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.add = MagicMock()

    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="# Batch Summary\n\nShared key points"))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)
    mock_llm_client.return_value = (client, "test-model")

    node = await upsert_source_batch_memory_node(
        session,
        user_id="user-1",
        group_key="feed:test|date:2026-05-21",
        sources=sources,
    )

    assert node is not None
    assert node.id == source_batch_memory_node_id("user-1", "feed:test|date:2026-05-21", ["src-1", "src-2"])
    assert node.node_type == "source"
    assert node.level == "batch"
    assert node.derived_from_sources == ["src-1", "src-2"]
    assert node.metadata_["source"] == "source_batch_memory_v1"
    assert node.metadata_["source_count"] == 2
    session.add.assert_called_once_with(node)
    mock_embedding.assert_awaited_once_with(session, node)
    mock_sync_edges.assert_awaited_once_with(session, node)
    mock_suggest.assert_awaited_once_with(
        session,
        user_id="user-1",
        trigger_type="memory",
        trigger_id=node.id,
    )


def _make_source(source_id: str = "src-1", title: str = "Test Source"):
    source = MagicMock(spec=[])
    source.id = source_id
    source.user_id = "user-1"
    source.title = title
    source.source_type = "article"
    source.url = "https://example.com"
    source.content_hash = "hash-1"
    source.raw_content = "Source content about memory trees."
    source.metadata_ = {}
    return source
