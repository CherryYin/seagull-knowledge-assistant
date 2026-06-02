import pytest

from pkg.services import action_agent


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
    monkeypatch.setattr("pkg.services.skills.load_skills_merged", _stub_load_skills)
    monkeypatch.setattr("pkg.services.skills.format_skills_for_prompt", lambda skills: "")

    prompt = await action_agent.build_system_prompt()

    assert "当前工作区项目画像" in prompt
    assert "Core capability: test profile" in prompt


@pytest.mark.asyncio
async def test_build_system_prompt_can_disable_workspace_profile(monkeypatch, tmp_path):
    profile = tmp_path / "AGENTS.md"
    profile.write_text("should not appear", encoding="utf-8")

    monkeypatch.setattr(action_agent.settings, "AGENT_LOAD_WORKSPACE_PROFILE", False)
    monkeypatch.setattr(action_agent.settings, "AGENT_WORKSPACE_PROFILE_PATH", profile)
    monkeypatch.setattr(action_agent, "_get_cached_kb_stats", _stub_kb_stats)
    monkeypatch.setattr(action_agent, "_get_user_memory_section", _stub_user_memory)
    monkeypatch.setattr("pkg.services.skills.load_skills_merged", _stub_load_skills)
    monkeypatch.setattr("pkg.services.skills.format_skills_for_prompt", lambda skills: "")

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
