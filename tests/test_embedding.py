"""Tests for pkg.services.embedding — embedding service (mocked AsyncOpenAI)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.embedding import EmbeddingService


@pytest.fixture
def mock_openai_client():
    client = MagicMock()
    # Mock embeddings.create as async (AsyncOpenAI returns coroutines)
    mock_embedding = MagicMock()
    mock_embedding.embedding = [0.1] * 1024
    mock_response = MagicMock()
    mock_response.data = [mock_embedding]
    client.embeddings.create = AsyncMock(return_value=mock_response)
    return client


@pytest.fixture
def emb_service(mock_openai_client):
    svc = EmbeddingService()
    svc._client = mock_openai_client
    return svc


# ---------------------------------------------------------------------------
# embed_text
# ---------------------------------------------------------------------------
class TestEmbedText:
    @pytest.mark.asyncio
    async def test_returns_vector(self, emb_service):
        vec = await emb_service.embed_text("Hello world")
        assert isinstance(vec, list)
        assert len(vec) == 1024

    @pytest.mark.asyncio
    async def test_empty_input_fallback(self, emb_service, mock_openai_client):
        await emb_service.embed_text("")
        call_args = mock_openai_client.embeddings.create.call_args
        assert call_args[1]["input"] == "empty"

    @pytest.mark.asyncio
    async def test_whitespace_only_fallback(self, emb_service, mock_openai_client):
        await emb_service.embed_text("   \n  ")
        call_args = mock_openai_client.embeddings.create.call_args
        assert call_args[1]["input"] == "empty"

    @pytest.mark.asyncio
    async def test_long_text_truncated(self, emb_service, mock_openai_client):
        long_text = "x" * 10000
        await emb_service.embed_text(long_text)
        call_args = mock_openai_client.embeddings.create.call_args
        assert len(call_args[1]["input"]) <= 8000

    @pytest.mark.asyncio
    async def test_none_input_fallback(self, emb_service, mock_openai_client):
        await emb_service.embed_text(None)
        call_args = mock_openai_client.embeddings.create.call_args
        assert call_args[1]["input"] == "empty"


# ---------------------------------------------------------------------------
# embed_batch
# ---------------------------------------------------------------------------
class TestEmbedBatch:
    @pytest.mark.asyncio
    async def test_single_batch(self, emb_service, mock_openai_client):
        mock_item = MagicMock()
        mock_item.embedding = [0.5] * 1024
        mock_response = MagicMock()
        mock_response.data = [mock_item, mock_item]
        mock_openai_client.embeddings.create = AsyncMock(return_value=mock_response)

        vecs = await emb_service.embed_batch(["text1", "text2"])
        assert len(vecs) == 2
        mock_openai_client.embeddings.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_multi_batch(self, emb_service, mock_openai_client):
        def make_response(n):
            resp = MagicMock()
            resp.data = [MagicMock(embedding=[0.5] * 1024) for _ in range(n)]
            return resp

        # 25 texts with batch_size=10 → batches of 10, 10, 5
        mock_openai_client.embeddings.create = AsyncMock(
            side_effect=[
                make_response(10),
                make_response(10),
                make_response(5),
            ]
        )

        texts = [f"text-{i}" for i in range(25)]
        vecs = await emb_service.embed_batch(texts, batch_size=10)
        assert len(vecs) == 25
        # 25 texts with batch_size=10 → 3 API calls
        assert mock_openai_client.embeddings.create.call_count == 3

    @pytest.mark.asyncio
    async def test_empty_batch(self, emb_service, mock_openai_client):
        vecs = await emb_service.embed_batch([])
        assert vecs == []
        mock_openai_client.embeddings.create.assert_not_called()
