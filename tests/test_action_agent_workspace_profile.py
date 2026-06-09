import pytest
from unittest.mock import AsyncMock

from pkg.services.orchestration import action_agent


async def _stub_kb_stats():
    return "知识库统计。"


async def _stub_user_memory():
    return ""


async def _stub_load_skills(skills_dir):
    return []


@pytest.mark.asyncio
async def test_build_system_prompt_includes_workspace_profile(monkeypatch, tmp_path):
    profile = tmp_path / "AGENTS.md"
    profile.write_text("# Workspace\n\n- Core capability: test profile", encoding="utf-8")

    monkeypatch.setattr(action_agent.settings, "AGENT_LOAD_WORKSPACE_PROFILE", True)
    monkeypatch.setattr(action_agent.settings, "AGENT_WORKSPACE_PROFILE_PATH", profile)
    monkeypatch.setattr(action_agent.settings, "AGENT_WORKSPACE_PROFILE_MAX_CHARS", 12000)
    monkeypatch.setattr(action_agent, "_get_cached_kb_stats", _stub_kb_stats)
    monkeypatch.setattr(action_agent, "_get_user_memory_section", _stub_user_memory)
    monkeypatch.setattr("pkg.services.cross_cutting.skills.load_skills_merged", _stub_load_skills)
    monkeypatch.setattr("pkg.services.cross_cutting.skills.format_skills_for_prompt", lambda skills: "")

    prompt = await action_agent.build_system_prompt()

    assert "当前工作区项目画像" in prompt
    assert "Core capability: test profile" in prompt
    assert "stable Wiki" in prompt
    assert "默认只起草，不自动写入 durable knowledge" in prompt
    assert "不要自动创建或改写 Knowledge Tree、Wiki、Asset、Note" in prompt


def test_memory_read_schema_exposes_memory_type():
    from pkg.schemas.user import MemoryRead

    model = MemoryRead.model_validate({
        "id": 1,
        "memory_type": "activity_profile",
        "key": "user_profile",
        "value": {"summary": "x"},
        "updated_at": "2026-06-09T00:00:00",
    })

    assert model.memory_type == "activity_profile"


@pytest.mark.asyncio
async def test_build_system_prompt_splits_explicit_and_activity_memories(monkeypatch):
    explicit = type("Mem", (), {"key": "preferences", "memory_type": "preference", "value": {"tone": "concise"}})()
    derived = type("Mem", (), {"key": "user_profile", "memory_type": "activity_profile", "value": {"summary": "AI researcher"}})()

    class _Result:
        def scalars(self):
            return [explicit, derived]

    class _Session:
        async def execute(self, *_args, **_kwargs):
            return _Result()

    class _SessionCtx:
        async def __aenter__(self):
            return _Session()
        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _CurrentUser:
        def get(self):
            return "user-1"

    monkeypatch.setattr(action_agent, "current_user_id", _CurrentUser())
    monkeypatch.setattr("pkg.db.async_session", lambda: _SessionCtx())
    monkeypatch.setattr("pkg.services.foundation.memory_retriever.retrieve_for_profile", AsyncMock(return_value=[]))
    monkeypatch.setattr("pkg.services.foundation.memory_retriever.format_memory_context", lambda *_args, **_kwargs: "")

    section = await action_agent._get_user_memory_section()

    assert "User Profile / Preferences" in section
    assert "Activity-Derived Profile" in section
    assert "不能覆盖用户显式偏好" in section


@pytest.mark.asyncio
async def test_build_system_prompt_can_disable_workspace_profile(monkeypatch, tmp_path):
    profile = tmp_path / "AGENTS.md"
    profile.write_text("should not appear", encoding="utf-8")

    monkeypatch.setattr(action_agent.settings, "AGENT_LOAD_WORKSPACE_PROFILE", False)
    monkeypatch.setattr(action_agent.settings, "AGENT_WORKSPACE_PROFILE_PATH", profile)
    monkeypatch.setattr(action_agent, "_get_cached_kb_stats", _stub_kb_stats)
    monkeypatch.setattr(action_agent, "_get_user_memory_section", _stub_user_memory)
    monkeypatch.setattr("pkg.services.cross_cutting.skills.load_skills_merged", _stub_load_skills)
    monkeypatch.setattr("pkg.services.cross_cutting.skills.format_skills_for_prompt", lambda skills: "")

    prompt = await action_agent.build_system_prompt()

    assert "当前工作区项目画像" not in prompt
    assert "should not appear" not in prompt


def test_load_workspace_profile_truncates(monkeypatch, tmp_path):
    profile = tmp_path / "AGENTS.md"
    profile.write_text("abcdef", encoding="utf-8")

    monkeypatch.setattr(action_agent.settings, "AGENT_LOAD_WORKSPACE_PROFILE", True)
    monkeypatch.setattr(action_agent.settings, "AGENT_WORKSPACE_PROFILE_PATH", profile)
    monkeypatch.setattr(action_agent.settings, "AGENT_WORKSPACE_PROFILE_MAX_CHARS", 3)

    section = action_agent._load_workspace_profile()

    assert "abc" in section
    assert "def" not in section
    assert "[truncated]" in section
