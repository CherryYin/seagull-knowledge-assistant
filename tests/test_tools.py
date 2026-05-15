"""Tests for pkg.services.tools — agent tool functions (mocked DB)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.tools import agentic_rag, ask_human, read_note, search_knowledge


# ---------------------------------------------------------------------------
# ask_human (pure function, no DB)
# ---------------------------------------------------------------------------
class TestAskHuman:
    def test_returns_waiting_signal(self):
        result = ask_human._tool_func(question="Which direction?")
        assert "[WAITING_FOR_HUMAN]" in result
        assert "Which direction?" in result

    def test_includes_prompt_for_user(self):
        result = ask_human._tool_func(question="A or B?")
        assert "A or B?" in result


# ---------------------------------------------------------------------------
# search_knowledge (mocked DB)
# ---------------------------------------------------------------------------
class TestSearchKnowledge:
    @pytest.mark.asyncio
    async def test_no_results(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_ctx:
            mock_ctx.get.return_value = "test-user"

            mock_retriever = AsyncMock()
            mock_retriever.search.return_value = []

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.retriever.RetrieverAgent", return_value=mock_retriever):
                    result = await search_knowledge._tool_func(query="nonexistent")
                    assert "未找到" in result

    @pytest.mark.asyncio
    async def test_with_results(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_ctx:
            mock_ctx.get.return_value = "test-user"

            mock_result = MagicMock()
            mock_result.type = "note"
            mock_result.title = "Test Note"
            mock_result.id = "note-1"
            mock_result.score = 0.95
            mock_result.abstract = "Summary"
            mock_result.content_preview = "Preview"

            mock_retriever = AsyncMock()
            mock_retriever.search.return_value = [mock_result]

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.retriever.RetrieverAgent", return_value=mock_retriever):
                    result = await search_knowledge._tool_func(query="test")
                    assert "1 条" in result
                    assert "Test Note" in result
                    assert "0.95" in result


# ---------------------------------------------------------------------------
# agentic_rag (mocked DB)
# ---------------------------------------------------------------------------
class TestAgenticRag:
    @pytest.mark.asyncio
    async def test_no_results_includes_trace(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_ctx:
            mock_ctx.get.return_value = "test-user"

            mock_retriever = AsyncMock()
            mock_retriever.search.return_value = []

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.retriever.RetrieverAgent", return_value=mock_retriever):
                    result = await agentic_rag._tool_func(question="missing topic")
                    assert "未找到" in result
                    assert "检索轨迹" in result

    @pytest.mark.asyncio
    async def test_opens_best_note_and_summarizes_evidence(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_ctx:
            mock_ctx.get.return_value = "test-user"

            mock_result = MagicMock()
            mock_result.type = "note"
            mock_result.title = "Agentic RAG Note"
            mock_result.id = "note-1"
            mock_result.score = 0.91
            mock_result.abstract = "Agentic retrieval uses search and open tools."
            mock_result.content_preview = "Preview"

            mock_retriever = AsyncMock()
            mock_retriever.search.return_value = [mock_result]

            mock_note = MagicMock()
            mock_note.abstract = "Agentic retrieval uses search and open tools."
            mock_note.content = "The harness searches, opens, and summarizes evidence."
            mock_note.note_type = "concept"
            mock_note.domains = ["AI"]
            mock_note.tags = ["rag"]

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session.get.return_value = mock_note
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.retriever.RetrieverAgent", return_value=mock_retriever):
                    result = await agentic_rag._tool_func(question="agentic retrieval", open_top_n=1)
                    assert "Agentic RAG 证据简报" in result
                    assert "note-1" in result
                    assert "Agentic RAG Note" in result
                    assert "证据片段" in result


# ---------------------------------------------------------------------------
# read_note (mocked DB)
# ---------------------------------------------------------------------------
class TestReadNote:
    @pytest.mark.asyncio
    async def test_not_found(self):
        with patch("pkg.db.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_session.get.return_value = None
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await read_note._tool_func(note_id="nonexistent")
            assert "不存在" in result

    @pytest.mark.asyncio
    async def test_found(self):
        mock_note = MagicMock()
        mock_note.title = "My Note"
        mock_note.note_type = "concept"
        mock_note.status = "active"
        mock_note.confidence = "high"
        mock_note.domains = ["AI"]
        mock_note.tags = ["test"]
        mock_note.project = None
        mock_note.abstract = "Summary"
        mock_note.content = "Full content"
        mock_note.source_ids = ["src-1"]

        with patch("pkg.db.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_session.get.return_value = mock_note
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await read_note._tool_func(note_id="note-1")
            assert "My Note" in result
            assert "Full content" in result
            assert "src-1" in result
