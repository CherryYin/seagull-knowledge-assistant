"""Tests for pkg.services.tools — agent tool functions (mocked DB)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.tools import agentic_rag, ask_human, create_memory_from_conversation, create_skill, read_memory_node, read_note, search_knowledge, search_memory


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
# memory tools (mocked DB)
# ---------------------------------------------------------------------------
class TestMemoryTools:
    @pytest.mark.asyncio
    async def test_search_memory_returns_nodes(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_user_ctx, patch("pkg.services.action_agent.current_run_id") as mock_run_ctx:
            mock_user_ctx.get.return_value = "test-user"
            mock_run_ctx.get.return_value = "run-1"
            mock_node = MagicMock()
            mock_node.id = "mem-1"
            mock_node.title = "Memory Tree"
            mock_node.node_type = "topic"
            mock_node.level = "topic"
            mock_node.summary = "Compiled memory summary"
            mock_node.content = "Memory Tree connects durable context to evidence."

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session.commit = AsyncMock()
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.agent_memory.search_memory_nodes", new_callable=AsyncMock, return_value=[mock_node]) as mock_search, patch("pkg.services.agent_memory.record_agent_memory_use", new_callable=AsyncMock) as mock_record:
                    result = await search_memory._tool_func(query="Memory Tree", top_k=3)

            assert "Memory Tree" in result
            assert "mem-1" in result
            mock_search.assert_awaited_once()
            mock_record.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_read_memory_node_records_usage(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_user_ctx, patch("pkg.services.action_agent.current_run_id") as mock_run_ctx:
            mock_user_ctx.get.return_value = "test-user"
            mock_run_ctx.get.return_value = "run-1"
            mock_node = MagicMock()
            mock_node.id = "mem-1"
            mock_node.user_id = "test-user"
            mock_node.title = "Topic Memory"
            mock_node.node_type = "topic"
            mock_node.level = "topic"
            mock_node.summary = "Summary"
            mock_node.content = "Full memory content"
            mock_node.confidence_score = 0.7
            mock_node.child_node_ids = ["mem-child"]
            mock_node.derived_from_notes = ["note-1"]
            mock_node.derived_from_sources = ["src-1"]
            mock_node.derived_from_chunks = [1]

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session.get.return_value = mock_node
                mock_session.commit = AsyncMock()
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.agent_memory.record_agent_memory_use", new_callable=AsyncMock) as mock_record:
                    result = await read_memory_node._tool_func(memory_node_id="mem-1")

            assert "Full memory content" in result
            assert "note-1" in result
            assert "src-1" in result
            mock_record.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_create_memory_from_conversation_is_pending_review(self):
        with patch("pkg.services.action_agent.current_user_id") as mock_user_ctx, patch("pkg.services.action_agent.current_run_id") as mock_run_ctx:
            mock_user_ctx.get.return_value = "test-user"
            mock_run_ctx.get.return_value = "run-1"
            mock_node = MagicMock()
            mock_node.id = "mem-conv-1"
            mock_node.title = "Remember preference"

            with patch("pkg.db.async_session") as mock_session_ctx:
                mock_session = AsyncMock()
                mock_session.commit = AsyncMock()
                mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

                with patch("pkg.services.agent_memory.create_pending_conversation_memory", new_callable=AsyncMock, return_value=mock_node) as mock_create, patch("pkg.services.agent_memory.record_agent_memory_use", new_callable=AsyncMock):
                    result = await create_memory_from_conversation._tool_func(
                        title="Remember preference",
                        summary="User likes concise answers",
                        content="The user asked for concise answers.",
                        confidence_score=0.95,
                    )

            assert "pending-review" in result
            assert "confidence capped" in result
            assert mock_create.await_args.kwargs["confidence_score"] == 0.95



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


# ---------------------------------------------------------------------------
# create_skill (mocked DB + storage)
# ---------------------------------------------------------------------------
class TestCreateSkill:
    @pytest.mark.asyncio
    async def test_creates_skill_with_normalized_name(self):
        with patch("pkg.db.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_session.get.return_value = None
            mock_session.add = MagicMock()
            mock_session.commit = AsyncMock()
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            mock_storage = MagicMock()
            mock_storage.build_object_key.return_value = "skills/skill-my-test-skill/my-test-skill.md"
            mock_storage.upload_bytes = AsyncMock(return_value="oss://skills/skill-my-test-skill/my-test-skill.md")

            with patch("pkg.services.storage.get_storage_service", return_value=mock_storage):
                result = await create_skill._tool_func(
                    name="My Test Skill",
                    description="the user asks for a repeatable test workflow",
                    workflow="1. Inspect input.\n2. Produce output.",
                )

            assert "/my-test-skill" in result
            created = mock_session.add.call_args.args[0]
            assert created.id == "skill-my-test-skill"
            assert created.name == "my-test-skill"
            assert created.args[0]["name"] == "task"
            assert "Inspect input" in created.template
            mock_session.commit.assert_awaited()

    @pytest.mark.asyncio
    async def test_rejects_duplicate_skill(self):
        with patch("pkg.db.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_session.get.return_value = MagicMock()
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await create_skill._tool_func(
                name="existing-skill",
                description="duplicate",
                workflow="1. Do work.",
            )

            assert "已存在" in result


# ---------------------------------------------------------------------------
# find_skills (web tool)
# ---------------------------------------------------------------------------
class TestFindSkills:
    @pytest.mark.asyncio
    async def test_requires_tavily_key(self):
        from pkg.services.tools_web import find_skills

        with patch("pkg.services.tools_web.settings") as mock_settings:
            mock_settings.TAVILY_API_KEY = ""
            result = await find_skills._tool_func(topic="meeting notes")
            assert "TAVILY_API_KEY" in result
