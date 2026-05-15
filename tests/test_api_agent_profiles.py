"""Tests for agent profile API presets."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.api.agent_profiles import (
    STORY_WRITER_AGENT_NAME,
    STORY_WRITER_SKILLS,
    STORY_WRITER_TOOLS,
    agent_types,
    create_profile,
    create_story_writer_preset,
)
from pkg.schemas.agent_profile import AgentProfileCreate


class TestStoryWriterPreset:
    @pytest.mark.asyncio
    async def test_create_story_writer_preset(self, fake_user, mock_session):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = mock_result
        mock_session.refresh = _refresh_with_timestamps(mock_session.refresh)

        profile = await create_story_writer_preset(user=fake_user, db=mock_session)

        assert profile.name == STORY_WRITER_AGENT_NAME
        assert profile.agent_type == "story"
        assert profile.enabled_tools == STORY_WRITER_TOOLS
        assert profile.enabled_skills == STORY_WRITER_SKILLS
        assert "知识库" in profile.system_prompt_append
        mock_session.add.assert_called_once()
        mock_session.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_existing_story_writer_preset(self, fake_user, mock_session):
        existing = _make_agent_profile(fake_user.id)
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = existing
        mock_session.execute.return_value = mock_result

        profile = await create_story_writer_preset(user=fake_user, db=mock_session)

        assert profile.id == existing.id
        mock_session.add.assert_not_called()
        mock_session.commit.assert_not_awaited()


class TestAgentTypes:
    @pytest.mark.asyncio
    async def test_lists_base_agent_types(self, fake_user):
        types = await agent_types(_user=fake_user)

        assert [item["id"] for item in types] == ["action", "story"]

    @pytest.mark.asyncio
    async def test_create_story_type_applies_defaults(self, fake_user, mock_session):
        mock_session.refresh = _refresh_with_timestamps(mock_session.refresh)
        body = AgentProfileCreate(name="My Story Agent", agent_type="story")

        profile = await create_profile(body=body, user=fake_user, db=mock_session)

        assert profile.agent_type == "story"
        assert profile.enabled_tools == STORY_WRITER_TOOLS
        assert profile.enabled_skills == STORY_WRITER_SKILLS
        assert "连载故事" in profile.system_prompt_append


def _make_agent_profile(user_id: str):
    obj = MagicMock()
    obj.id = "profile-story"
    obj.user_id = user_id
    obj.agent_type = "story"
    obj.name = STORY_WRITER_AGENT_NAME
    obj.description = "Story agent"
    obj.system_prompt_append = "Use story skills and knowledge base."
    obj.model_id = None
    obj.temperature = 0.9
    obj.enabled_tools = STORY_WRITER_TOOLS
    obj.enabled_skills = STORY_WRITER_SKILLS
    obj.is_default = False
    obj.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    obj.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return obj


def _refresh_with_timestamps(original_refresh):
    async def _refresh(obj, *args, **kwargs):
        if not getattr(obj, "id", None):
            obj.id = "profile-story"
        if not getattr(obj, "created_at", None):
            obj.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        if not getattr(obj, "updated_at", None):
            obj.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

    return _refresh
