"""Tests for pkg.services.skills — skill loading, parsing, expansion."""

import textwrap
from pathlib import Path

import pytest

from pkg.services.skills import (
    SkillDef,
    SkillArg,
    _parse_skill_file,
    expand_skill,
    format_skills_for_prompt,
    load_skills_from_dir,
    parse_skill_invocation,
)


# ---------------------------------------------------------------------------
# parse_skill_invocation
# ---------------------------------------------------------------------------
class TestParseSkillInvocation:
    def test_simple(self):
        result = parse_skill_invocation("/summarize topic")
        assert result == ("summarize", ["topic"])

    def test_no_slash(self):
        assert parse_skill_invocation("hello") is None

    def test_multi_args(self):
        result = parse_skill_invocation("/deep-research quantum computing")
        assert result == ("deep-research", ["quantum", "computing"])

    def test_quoted_args(self):
        result = parse_skill_invocation('/summarize "multi word topic"')
        assert result == ("summarize", ["multi word topic"])

    def test_no_args(self):
        result = parse_skill_invocation("/stats")
        assert result == ("stats", [])

    def test_invalid_name(self):
        assert parse_skill_invocation("/UPPER") is None
        assert parse_skill_invocation("/-bad") is None

    def test_empty(self):
        assert parse_skill_invocation("") is None
        assert parse_skill_invocation("/") is None


# ---------------------------------------------------------------------------
# expand_skill
# ---------------------------------------------------------------------------
class TestExpandSkill:
    def test_positional_args(self):
        skill = SkillDef(name="test", description="", template="Search $1 in $2")
        result = expand_skill(skill, ["topic", "database"])
        assert result == "Search topic in database"

    def test_all_args(self):
        skill = SkillDef(name="test", description="", template="Research: $@")
        result = expand_skill(skill, ["quantum", "computing"])
        assert result == "Research: quantum computing"

    def test_missing_args_removed(self):
        skill = SkillDef(name="test", description="", template="$1 and $2 and $3")
        result = expand_skill(skill, ["a", "b"])
        assert result == "a and b and"

    def test_no_args(self):
        skill = SkillDef(name="test", description="", template="Static prompt")
        result = expand_skill(skill, [])
        assert result == "Static prompt"


# ---------------------------------------------------------------------------
# format_skills_for_prompt
# ---------------------------------------------------------------------------
class TestFormatSkillsForPrompt:
    def test_empty(self):
        assert format_skills_for_prompt([]) == ""

    def test_single_skill(self):
        skill = SkillDef(
            name="summarize",
            description="Summarize a topic",
            template="",
            args=[SkillArg(name="topic", required=True)],
        )
        result = format_skills_for_prompt([skill])
        assert "/summarize <topic>" in result
        assert "Summarize a topic" in result


# ---------------------------------------------------------------------------
# load_skills_from_dir
# ---------------------------------------------------------------------------
class TestLoadSkillsFromDir:
    def test_nonexistent_dir(self):
        assert load_skills_from_dir(Path("/nonexistent")) == []

    def test_load_real_skills(self):
        skills = load_skills_from_dir(Path("./skills"))
        assert len(skills) > 0
        names = [s.name for s in skills]
        assert "deep-research" in names

    def test_parse_skill_file(self, tmp_path):
        md = tmp_path / "test-skill.md"
        md.write_text(textwrap.dedent("""\
            ---
            name: test-skill
            description: A test skill
            args:
              - name: arg1
                required: true
            ---
            Do something with $1
        """))
        skill = _parse_skill_file(md)
        assert skill is not None
        assert skill.name == "test-skill"
        assert skill.description == "A test skill"
        assert len(skill.args) == 1
        assert skill.args[0].required is True

    def test_empty_template_skipped(self, tmp_path):
        md = tmp_path / "empty.md"
        md.write_text("---\nname: empty\n---\n")
        skill = _parse_skill_file(md)
        assert skill is None
