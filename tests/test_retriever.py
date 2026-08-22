from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.retriever import RetrieverAgent


def _empty_result() -> MagicMock:
    result = MagicMock()
    result.scalars.return_value = []
    result.__iter__.return_value = iter([])
    return result


@pytest.mark.asyncio
@patch("pkg.services.foundation.retriever.get_embedding_service")
async def test_sql_search_does_not_query_memory_nodes(mock_embedding_service):
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_empty_result() for _ in range(4)])
    retriever = RetrieverAgent(session, user_id="user-1")

    assert await retriever.sql_search("topic", top_k=5) == []

    statements = [str(call.args[0]) for call in session.execute.await_args_list]
    assert len(statements) == 4
    assert all("memory_nodes" not in statement for statement in statements)
    mock_embedding_service.assert_called_once_with()


@pytest.mark.asyncio
@patch("pkg.services.foundation.retriever.get_embedding_service")
async def test_vector_search_does_not_query_memory_embeddings(mock_embedding_service):
    embedding_service = AsyncMock()
    embedding_service.embed_text = AsyncMock(return_value=[0.1, 0.2])
    mock_embedding_service.return_value = embedding_service
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_empty_result() for _ in range(5)])
    retriever = RetrieverAgent(session, user_id="user-1")

    assert await retriever.vector_search("topic", top_k=5) == []

    statements = [str(call.args[0]) for call in session.execute.await_args_list]
    assert len(statements) == 5
    assert all("memory_embeddings" not in statement for statement in statements)
    assert all("memory_nodes" not in statement for statement in statements)
