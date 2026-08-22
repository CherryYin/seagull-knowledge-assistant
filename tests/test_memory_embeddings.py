from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.memory import MemoryNode
from pkg.services.foundation.memory_embeddings import upsert_memory_embedding


@pytest.mark.asyncio
@patch("pkg.services.foundation.memory_embeddings.get_embedding_service")
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
    embedding_service = AsyncMock()
    embedding_service.embed_text = AsyncMock(return_value=[0.1, 0.2])
    mock_embedding_service.return_value = embedding_service

    await upsert_memory_embedding(session, node)

    session.flush.assert_awaited_once_with([node])
    session.add.assert_called_once()
