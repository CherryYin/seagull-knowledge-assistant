"""Skill system — reusable prompt templates with optional executable tools.

Skills are Markdown files with YAML frontmatter. They live in two places:
1. Local `skills/` directory (for development, version-controlled)
2. PostgreSQL + OSS (for persistence, API-managed)

Skills can optionally have a companion `.py` file that defines Strands tools
which get dynamically registered with the Agent at creation time.

Skill file format (skills/my-skill.md):

    ---
    name: my-skill
    description: One-line description
    args:
      - name: topic
        required: true
    tools: my-skill.py          # optional companion file
    ---

    Prompt template. Use $1, $2 for positional args, $@ for all args.
"""
import hashlib
import importlib.util
import logging
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import frontmatter

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class SkillArg:
    name: str
    description: str = ""
    required: bool = False


@dataclass
class SkillDef:
    name: str
    description: str
    template: str
    args: list[SkillArg] = field(default_factory=list)
    tools_file: str | None = None
    file_path: str = ""
    content_hash: str = ""
    source: str = "local"  # "local" or "db"


# ---------------------------------------------------------------------------
# Local file loading
# ---------------------------------------------------------------------------
def _parse_skill_file(md_file: Path) -> SkillDef | None:
    """Parse a single skill Markdown file. Returns None on failure."""
    try:
        post = frontmatter.load(str(md_file))
        meta = post.metadata

        name = meta.get("name", "") or md_file.stem
        if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
            logger.warning("Skill %s has invalid name '%s', skipping", md_file, name)
            return None

        description = meta.get("description", "")
        raw_args = meta.get("args", [])
        skill_args = []
        if isinstance(raw_args, list):
            for a in raw_args:
                if isinstance(a, dict):
                    skill_args.append(SkillArg(
                        name=a.get("name", ""),
                        description=a.get("description", ""),
                        required=bool(a.get("required", False)),
                    ))
                elif isinstance(a, str):
                    skill_args.append(SkillArg(name=a))

        template = post.content.strip()
        if not template:
            logger.warning("Skill %s has empty template, skipping", md_file)
            return None

        tools_file = meta.get("tools", None)
        raw_content = md_file.read_text(encoding="utf-8")
        content_hash = hashlib.sha256(raw_content.encode()).hexdigest()

        return SkillDef(
            name=name,
            description=description,
            template=template,
            args=skill_args,
            tools_file=tools_file,
            file_path=str(md_file),
            content_hash=content_hash,
            source="local",
        )
    except Exception:
        logger.warning("Failed to parse skill file %s", md_file, exc_info=True)
        return None


def load_skills_from_dir(skills_dir: Path) -> list[SkillDef]:
    """Load skills from a local directory."""
    if not skills_dir.is_dir():
        return []

    skills: list[SkillDef] = []
    seen: set[str] = set()

    for md_file in sorted(skills_dir.glob("*.md")):
        skill = _parse_skill_file(md_file)
        if skill and skill.name not in seen:
            seen.add(skill.name)
            skills.append(skill)
        elif skill:
            logger.warning("Duplicate skill name '%s' in %s, skipping", skill.name, md_file)

    return skills


async def load_skills_from_db() -> list[SkillDef]:
    """Load skills from the database."""
    try:
        from sqlalchemy import select

        from pkg.db import async_session
        from pkg.models.skill import Skill

        async with async_session() as session:
            rows = await session.execute(
                select(Skill).order_by(Skill.name)
            )
            db_skills = list(rows.scalars())

        return [
            SkillDef(
                name=s.name,
                description=s.description,
                template=s.template,
                args=[SkillArg(**a) for a in (s.args or [])],
                tools_file=s.tools_file,
                file_path=s.file_path or "",
                content_hash=s.content_hash,
                source="db",
            )
            for s in db_skills
        ]
    except Exception:
        logger.warning("Failed to load skills from DB", exc_info=True)
        return []


def load_skills(skills_dir: Path) -> list[SkillDef]:
    """Load and merge skills from local dir + DB. Local takes priority."""
    local = load_skills_from_dir(skills_dir)
    # DB loading is async but we need a sync interface for prompt building.
    # For the sync path, just return local skills.
    return local


async def load_skills_merged(skills_dir: Path) -> list[SkillDef]:
    """Async: load and merge skills from local dir + DB. Local takes priority."""
    local = load_skills_from_dir(skills_dir)
    local_names = {s.name for s in local}

    db_skills = await load_skills_from_db()
    for s in db_skills:
        if s.name not in local_names:
            local.append(s)

    return sorted(local, key=lambda s: s.name)


# ---------------------------------------------------------------------------
# Sync pipeline (local → DB + OSS)
# ---------------------------------------------------------------------------
async def sync_skills_from_directory(
    db_session: Any,
    skills_dir: Path,
) -> dict[str, int]:
    """Sync local skill files to DB + OSS. Returns stats dict."""
    from pkg.models.skill import Skill
    from pkg.services.storage import get_storage_service

    stats = {"created": 0, "updated": 0, "skipped": 0}

    if not skills_dir.is_dir():
        return stats

    storage = get_storage_service()

    for md_file in sorted(skills_dir.glob("*.md")):
        skill = _parse_skill_file(md_file)
        if not skill:
            continue

        skill_id = f"skill-{skill.name}"
        existing = await db_session.get(Skill, skill_id)

        if existing and existing.content_hash == skill.content_hash:
            stats["skipped"] += 1
            continue

        # Upload to OSS
        object_key = storage.build_object_key("skills", skill_id, f"{skill.name}.md")
        raw_content = md_file.read_text(encoding="utf-8")
        storage_uri = await storage.upload_bytes(
            object_key=object_key,
            data=raw_content.encode("utf-8"),
            content_type="text/markdown",
        )

        if existing:
            existing.description = skill.description
            existing.args = [{"name": a.name, "description": a.description, "required": a.required} for a in skill.args]
            existing.template = skill.template
            existing.tools_file = skill.tools_file
            existing.file_path = storage_uri
            existing.content_hash = skill.content_hash
            stats["updated"] += 1
        else:
            db_session.add(Skill(
                id=skill_id,
                name=skill.name,
                description=skill.description,
                args=[{"name": a.name, "description": a.description, "required": a.required} for a in skill.args],
                template=skill.template,
                tools_file=skill.tools_file,
                file_path=storage_uri,
                content_hash=skill.content_hash,
            ))
            stats["created"] += 1

    await db_session.commit()
    return stats


# ---------------------------------------------------------------------------
# Dynamic tool loading from companion .py files
# ---------------------------------------------------------------------------
def load_skill_tools(skills_dir: Path, skills: list[SkillDef]) -> list:
    """Load Strands @tool-decorated functions from companion .py files.

    Returns a list of tool objects that can be appended to Agent's tools.
    """
    from strands.tools.decorator import DecoratedFunctionTool

    tools: list = []

    for skill in skills:
        if not skill.tools_file:
            continue

        py_path = skills_dir / skill.tools_file
        if not py_path.is_file():
            logger.warning(
                "Skill '%s' references tools file '%s' but it doesn't exist",
                skill.name, skill.tools_file,
            )
            continue

        try:
            spec = importlib.util.spec_from_file_location(
                f"skill_tools_{skill.name}", str(py_path)
            )
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                if isinstance(attr, DecoratedFunctionTool):
                    tools.append(attr)
                    logger.info(
                        "Loaded tool '%s' from skill '%s'",
                        attr_name, skill.name,
                    )
        except Exception:
            logger.warning(
                "Failed to load tools from %s for skill '%s'",
                py_path, skill.name, exc_info=True,
            )

    return tools


# ---------------------------------------------------------------------------
# Prompt formatting
# ---------------------------------------------------------------------------
def format_skills_for_prompt(skills: list[SkillDef]) -> str:
    """Format skill definitions as a section to append to the system prompt."""
    if not skills:
        return ""

    lines = [
        "\n## 可用技能",
        "用户可能会以 `/skill-name 参数` 的方式调用技能。识别到技能调用时，按照技能的意图执行任务。\n",
    ]
    for s in skills:
        args_hint = " ".join(
            f"<{a.name}>" if a.required else f"[{a.name}]"
            for a in s.args
        )
        usage = f"/{s.name} {args_hint}".strip()
        lines.append(f"- `{usage}`: {s.description}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Invocation parsing and expansion
# ---------------------------------------------------------------------------
def parse_skill_invocation(text: str) -> tuple[str, list[str]] | None:
    """Parse a "/skill-name arg1 arg2" invocation from user input."""
    text = text.strip()
    if not text.startswith("/"):
        return None

    try:
        parts = shlex.split(text)
    except ValueError:
        parts = text.split()

    if not parts:
        return None

    skill_name = parts[0][1:]
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", skill_name):
        return None

    return skill_name, parts[1:]


def expand_skill(skill: SkillDef, args: list[str]) -> str:
    """Expand a skill template by substituting positional arguments."""
    result = skill.template
    result = result.replace("$@", " ".join(args))

    for i, arg in enumerate(args, 1):
        result = result.replace(f"${i}", arg)

    result = re.sub(r"\$\d+", "", result)
    return result.strip()
