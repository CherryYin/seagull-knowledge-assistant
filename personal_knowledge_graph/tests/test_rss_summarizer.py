"""Tests for RSS topic summarization request shaping."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.config import settings
from pkg.services.foundation.rss_summarizer import summarize_rss_by_topic


class _AsyncSessionFactory:
    def __init__(self, *sessions):
        self.sessions = list(sessions)

    def __call__(self):
        session = self.sessions.pop(0)
        manager = AsyncMock()
        manager.__aenter__.return_value = session
        manager.__aexit__.return_value = False
        return manager


class TestSummarizeRssByTopic:
    @pytest.mark.asyncio
    async def test_limits_prompt_and_passes_timeout(self, monkeypatch):
        monkeypatch.setattr(settings, "RSS_SUMMARY_MAX_ARTICLES", 1)
        monkeypatch.setattr(settings, "RSS_SUMMARY_MAX_CHARS_PER_ARTICLE", 10)
        monkeypatch.setattr(settings, "RSS_SUMMARY_LLM_TIMEOUT", 123)

        article = MagicMock()
        article.id = "source-1"
        article.user_id = "user-1"
        article.title = "Long Article"
        article.url = "https://example.com/a"
        article.raw_content = "x" * 100
        article.metadata_ = {"published_at": "2026-05-13T00:00:00Z"}
        result = MagicMock()
        result.scalars.return_value = [article]

        read_session = AsyncMock()
        read_session.execute.return_value = result
        write_session = AsyncMock()

        response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='[{"topic":"T","summary":"S"}]'))],
            usage=None,
        )
        completions = AsyncMock(return_value=response)
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=completions)))

        persisted_note = SimpleNamespace(id="note-1")

        with patch("pkg.services.foundation.rss_summarizer.async_session", _AsyncSessionFactory(read_session, write_session)):
            with patch("pkg.services.cross_cutting.llm.create_async_client", return_value=(client, "qwen-plus")):
                with patch("pkg.api.categories.get_default_category_id", new_callable=AsyncMock, return_value=1):
                    with patch("pkg.api.notes.put_note_markdown_oss", new_callable=AsyncMock, return_value="minio://note"):
                        with patch("pkg.api.notes.persist_note", new_callable=AsyncMock, return_value=persisted_note):
                            note_ids = await summarize_rss_by_topic()

        assert note_ids == ["note-1"]
        kwargs = completions.await_args.kwargs
        assert kwargs["timeout"] == 123
        user_prompt = kwargs["messages"][1]["content"]
        assert "x" * 10 in user_prompt
        assert "x" * 11 not in user_prompt
