"""Tests for pkg.services.cross_cutting.user_profiler — user profile generation (mocked DB + LLM)."""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.user_profiler import (
    PROFILE_MEMORY_KEY,
    _format_activity_summary,
    _get_profile_memory_context,
    _get_recent_activities,
    _get_chat_stats,
    _get_note_stats,
    _get_source_stats,
    generate_user_profile,
)


# ---------------------------------------------------------------------------
# _format_activity_summary (pure function)
# ---------------------------------------------------------------------------
class TestFormatActivitySummary:
    def test_basic_format(self):
        activities = {
            "search_queries": ["投资策略", "资产配置"],
            "chat_topics": ["如何做deep research"],
            "active_period": "evening",
            "total_activities": 10,
        }
        note_stats = {"total": 5, "domains": {"AI": 3, "finance": 2}, "tags": {"LLM": 2}, "types": {"concept": 3}}
        source_stats = {"total": 3, "types": {"pdf": 2, "article": 1}, "titles": ["Paper A"]}
        chat_stats = {"total": 4, "titles": ["投资讨论", "AI研究"]}

        result = _format_activity_summary(activities, note_stats, source_stats, chat_stats)
        assert "投资策略" in result
        assert "evening" in result
        assert "AI" in result
        assert "Paper A" in result
        assert "投资讨论" in result

    def test_empty_data(self):
        activities = {"search_queries": [], "chat_topics": [], "active_period": "unknown", "total_activities": 0}
        note_stats = {"total": 0, "domains": {}, "tags": {}, "types": {}}
        source_stats = {"total": 0, "types": {}, "titles": []}
        chat_stats = {"total": 0, "titles": []}

        result = _format_activity_summary(activities, note_stats, source_stats, chat_stats)
        assert "活动概览" in result
        assert "0" in result

    def test_includes_memory_context(self):
        activities = {"search_queries": [], "chat_topics": [], "active_period": "unknown", "total_activities": 0}
        note_stats = {"total": 0, "domains": {}, "tags": {}, "types": {}}
        source_stats = {"total": 0, "types": {}, "titles": []}
        chat_stats = {"total": 0, "titles": []}

        result = _format_activity_summary(
            activities,
            note_stats,
            source_stats,
            chat_stats,
            memory_context="Relevant long-term memory:\n1. AI research focus",
        )

        assert "Memory Tree 长期上下文" in result
        assert "AI research focus" in result


# ---------------------------------------------------------------------------
# _get_profile_memory_context (mocked retriever)
# ---------------------------------------------------------------------------
class TestGetProfileMemoryContext:
    @pytest.mark.asyncio
    async def test_formats_retrieved_memories(self):
        with patch("pkg.services.cross_cutting.user_profiler.async_session") as mock_session_factory:
            mock_session = AsyncMock()
            mock_session_factory.return_value.__aenter__.return_value = mock_session

            with patch("pkg.services.cross_cutting.user_profiler.retrieve_for_profile", new_callable=AsyncMock) as mock_retrieve:
                mock_retrieve.return_value = [MagicMock()]
                with patch("pkg.services.cross_cutting.user_profiler.format_memory_context") as mock_format:
                    mock_format.return_value = "memory context"

                    result = await _get_profile_memory_context("user-1")

                    assert result == "memory context"
                    mock_retrieve.assert_awaited_once_with(mock_session, user_id="user-1", limit=20)
                    mock_format.assert_called_once_with(mock_retrieve.return_value, max_chars_per_item=500)


# ---------------------------------------------------------------------------
# _get_recent_activities (mocked DB)
# ---------------------------------------------------------------------------
class TestGetRecentActivities:
    @pytest.mark.asyncio
    async def test_extracts_queries_and_topics(self):
        mock_logs = []
        for i in range(3):
            log = MagicMock()
            log.action = "search"
            log.detail = {"query": f"query-{i}"}
            log.created_at = datetime(2026, 1, 1, 14, 0, tzinfo=timezone.utc)
            mock_logs.append(log)

        chat_log = MagicMock()
        chat_log.action = "chat"
        chat_log.detail = {"task": "discuss AI"}
        chat_log.created_at = datetime(2026, 1, 1, 20, 0, tzinfo=timezone.utc)
        mock_logs.append(chat_log)

        with patch("pkg.services.cross_cutting.user_profiler.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_result = MagicMock()
            mock_result.scalars.return_value = mock_logs
            mock_session.execute.return_value = mock_result
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await _get_recent_activities("user-1", days=30)

        assert len(result["search_queries"]) == 3
        assert result["chat_topics"] == ["discuss AI"]
        assert result["total_activities"] == 4

    @pytest.mark.asyncio
    async def test_empty_logs(self):
        with patch("pkg.services.cross_cutting.user_profiler.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_result = MagicMock()
            mock_result.scalars.return_value = []
            mock_session.execute.return_value = mock_result
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await _get_recent_activities("user-1")

        assert result["search_queries"] == []
        assert result["chat_topics"] == []
        assert result["active_period"] == "unknown"

    @pytest.mark.asyncio
    async def test_uses_naive_datetime_cutoff(self):
        with patch("pkg.services.cross_cutting.user_profiler.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_result = MagicMock()
            mock_result.scalars.return_value = []
            mock_session.execute.return_value = mock_result
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            await _get_recent_activities("user-1")

        stmt = mock_session.execute.await_args.args[0]
        cutoff = stmt.compile().params["created_at_1"]
        assert cutoff.tzinfo is None


class TestGetChatStats:
    @pytest.mark.asyncio
    async def test_uses_naive_datetime_cutoff(self):
        with patch("pkg.services.cross_cutting.user_profiler.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_result = MagicMock()
            mock_result.scalars.return_value = []
            mock_session.execute.return_value = mock_result
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            await _get_chat_stats("user-1")

        stmt = mock_session.execute.await_args.args[0]
        cutoff = stmt.compile().params["updated_at_1"]
        assert cutoff.tzinfo is None


# ---------------------------------------------------------------------------
# _get_note_stats (mocked DB)
# ---------------------------------------------------------------------------
class TestGetNoteStats:
    @pytest.mark.asyncio
    async def test_with_notes(self):
        note1 = MagicMock()
        note1.note_type = "concept"
        note1.domains = ["AI", "ML"]
        note1.tags = ["LLM"]

        note2 = MagicMock()
        note2.note_type = "how-to"
        note2.domains = ["AI"]
        note2.tags = ["tutorial"]

        with patch("pkg.services.cross_cutting.user_profiler.async_session") as mock_session_ctx:
            mock_session = AsyncMock()
            mock_result = MagicMock()
            mock_result.scalars.return_value = [note1, note2]
            mock_session.execute.return_value = mock_result
            mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await _get_note_stats("user-1")

        assert result["total"] == 2
        assert result["domains"]["AI"] == 2
        assert result["types"]["concept"] == 1


# ---------------------------------------------------------------------------
# generate_user_profile (integration, mocked DB + LLM)
# ---------------------------------------------------------------------------
class TestGenerateUserProfile:
    @pytest.mark.asyncio
    async def test_insufficient_data(self):
        with patch("pkg.services.cross_cutting.user_profiler._get_recent_activities") as mock_act:
            mock_act.return_value = {"search_queries": [], "chat_topics": [], "active_period": "unknown", "total_activities": 0}
            with patch("pkg.services.cross_cutting.user_profiler._get_note_stats") as mock_notes:
                mock_notes.return_value = {"total": 0, "domains": {}, "tags": {}, "types": {}}
                with patch("pkg.services.cross_cutting.user_profiler._get_source_stats") as mock_src:
                    mock_src.return_value = {"total": 0, "types": {}, "titles": []}
                    with patch("pkg.services.cross_cutting.user_profiler._get_chat_stats") as mock_chat:
                        mock_chat.return_value = {"total": 0, "titles": []}
                        with patch("pkg.services.cross_cutting.user_profiler._get_profile_memory_context") as mock_memory:
                            mock_memory.return_value = ""

                            result = await generate_user_profile("user-1")
                            assert result is None

    @pytest.mark.asyncio
    async def test_successful_generation(self):
        profile_json = json.dumps({
            "interests": [{"domain": "AI", "depth": "advanced", "recent_focus": "LLM"}],
            "knowledge_level": {"AI": "advanced"},
            "behavior": {
                "primary_usage": "deep_research",
                "active_hours": "evening",
                "content_preference": "长文",
                "interaction_style": "结构化",
            },
            "summary": "AI researcher",
        })

        with patch("pkg.services.cross_cutting.user_profiler._get_recent_activities") as mock_act:
            mock_act.return_value = {
                "search_queries": ["LLM", "transformer", "attention"],
                "chat_topics": ["explain attention"],
                "active_period": "evening",
                "total_activities": 10,
            }
            with patch("pkg.services.cross_cutting.user_profiler._get_note_stats") as mock_notes:
                mock_notes.return_value = {"total": 5, "domains": {"AI": 5}, "tags": {}, "types": {}}
                with patch("pkg.services.cross_cutting.user_profiler._get_source_stats") as mock_src:
                    mock_src.return_value = {"total": 3, "types": {"pdf": 3}, "titles": []}
                    with patch("pkg.services.cross_cutting.user_profiler._get_chat_stats") as mock_chat:
                        mock_chat.return_value = {"total": 2, "titles": ["AI讨论"]}
                        with patch("pkg.services.cross_cutting.user_profiler._get_profile_memory_context") as mock_memory:
                            mock_memory.return_value = "Relevant long-term memory:\nAI research focus"
                            with patch("pkg.services.cross_cutting.user_profiler._llm_generate_profile") as mock_llm:
                                mock_llm.return_value = json.loads(profile_json)
                                with patch("pkg.services.cross_cutting.user_profiler._upsert_user_memory") as mock_store:
                                    result = await generate_user_profile("user-1")

                                    assert result is not None
                                    assert result["interests"][0]["domain"] == "AI"
                                    mock_store.assert_awaited_once_with("user-1", PROFILE_MEMORY_KEY, result)
