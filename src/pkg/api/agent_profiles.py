from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import get_session
from pkg.models.agent_profile import AgentProfile
from pkg.models.user import User
from pkg.schemas.agent_profile import (
    AgentProfileCreate,
    AgentProfileList,
    AgentProfileRead,
    AgentProfileUpdate,
)

router = APIRouter()


STORY_WRITER_AGENT_NAME = "Serial Story Writer"

STORY_WRITER_SYSTEM_PROMPT = """\
你是用户的专属连载故事写作 Agent。你的目标是帮助用户长期稳定地创作连载小说、剧集式故事和长篇叙事。

工作方式：
1. 写作前先理解用户给出的题材、简介、前情提要、故事圣经和本章目标。
2. 主动参考用户知识库中的相关笔记和资料：
   - 使用 search_knowledge 搜索与题材、世界观、角色职业、历史原型、技术设定、写作偏好相关的内容。
   - 对关键结果使用 read_note 或 read_source 读取完整内容。
   - 如果用户明确要求只按提供材料写作，则不要额外检索。
3. 续写正文时优先使用 serial-story-writer skill 的原则：承接前情、推进情节、保持人物一致、结尾留下钩子。
4. 维护长期设定时使用 story-bible-maintainer skill 的原则：更新人物表、世界观规则、时间线、伏笔、冲突和下一章约束。
5. 不要为了炫技而引入过多新设定；新设定必须服务主线、人物变化或悬念回收。
6. 如果关键信息不足，先问 1-3 个最必要的问题；如果可以合理假设，则先说明假设并继续。

默认输出偏好：
- 使用中文。
- 正文要有画面感和连载节奏。
- 对话要推动人物关系或冲突。
- 写完后给出简短的“本章推进”和“下一章可承接方向”。
"""

STORY_WRITER_TOOLS = [
    "search_knowledge",
    "read_note",
    "read_source",
    "list_notes",
    "list_sources",
    "knowledge_stats",
    "ask_human",
]

STORY_WRITER_SKILLS = ["serial-story-writer", "story-bible-maintainer"]

AGENT_TYPES = [
    {
        "id": "action",
        "name": "Action Agent",
        "description": "通用行动 Agent，可搜索知识库、处理资料、调用工具并执行复杂任务。",
        "default_tools": None,
        "default_skills": None,
    },
    {
        "id": "story",
        "name": "Story Agent",
        "description": "连载故事写作 Agent，会参考你的知识库和笔记，并使用故事续写与故事圣经维护 skills。",
        "default_tools": STORY_WRITER_TOOLS,
        "default_skills": STORY_WRITER_SKILLS,
    },
]


def _get_available_tool_names() -> list[str]:
    from pkg.services.orchestration.action_agent import _BASE_TOOLS

    names = []
    for t in _BASE_TOOLS:
        name = getattr(t, "tool_name", None) or getattr(t, "__name__", None)
        if name:
            names.append(name)
    return names


async def _clear_default(db: AsyncSession, user_id: str) -> None:
    result = await db.execute(
        select(AgentProfile).where(
            AgentProfile.user_id == user_id,
            AgentProfile.is_default.is_(True),
        )
    )
    for profile in result.scalars():
        profile.is_default = False


async def _get_profile_by_name(db: AsyncSession, user_id: str, name: str) -> AgentProfile | None:
    result = await db.execute(
        select(AgentProfile).where(
            AgentProfile.user_id == user_id,
            AgentProfile.name == name,
        )
    )
    return result.scalar_one_or_none()


def _apply_agent_type_defaults(data: dict) -> dict:
    agent_type = data.get("agent_type") or "action"
    if agent_type == "story":
        data.setdefault("description", "专门用于长期连载故事创作，会参考你的知识库和笔记，并使用故事续写/故事圣经维护 skills。")
        data.setdefault("temperature", 0.9)
        if not data.get("system_prompt_append"):
            data["system_prompt_append"] = STORY_WRITER_SYSTEM_PROMPT
        if data.get("enabled_tools") is None:
            data["enabled_tools"] = STORY_WRITER_TOOLS
        if data.get("enabled_skills") is None:
            data["enabled_skills"] = STORY_WRITER_SKILLS
    return data


@router.get("/available-tools")
async def available_tools(_user: User = Depends(get_current_user)) -> list[str]:
    return _get_available_tool_names()


@router.get("/allowed-models")
async def allowed_models(_user: User = Depends(get_current_user)) -> list[str]:
    from pkg.services.cross_cutting.llm import list_all_models

    models = await list_all_models()
    if models:
        return [m["id"] for m in models]
    return settings.ALLOWED_MODELS


@router.get("/types")
async def agent_types(_user: User = Depends(get_current_user)) -> list[dict]:
    return AGENT_TYPES


@router.post("", response_model=AgentProfileRead, status_code=201)
async def create_profile(
    body: AgentProfileCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    if body.is_default:
        await _clear_default(db, user.id)

    data = _apply_agent_type_defaults(body.model_dump())
    profile = AgentProfile(user_id=user.id, **data)
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


@router.post("/presets/story-writer", response_model=AgentProfileRead, status_code=201)
async def create_story_writer_preset(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Create or return the built-in serial story writing agent profile."""
    existing = await _get_profile_by_name(db, user.id, STORY_WRITER_AGENT_NAME)
    if existing:
        return existing

    profile = AgentProfile(
        user_id=user.id,
        agent_type="story",
        name=STORY_WRITER_AGENT_NAME,
        description="专门用于长期连载故事创作，会参考你的知识库和笔记，并使用故事续写/故事圣经维护 skills。",
        system_prompt_append=STORY_WRITER_SYSTEM_PROMPT,
        temperature=0.9,
        enabled_tools=STORY_WRITER_TOOLS,
        enabled_skills=STORY_WRITER_SKILLS,
        is_default=False,
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


@router.get("", response_model=AgentProfileList)
async def list_profiles(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    count_stmt = (
        select(func.count()).select_from(AgentProfile).where(AgentProfile.user_id == user.id)
    )
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(AgentProfile)
        .where(AgentProfile.user_id == user.id)
        .order_by(AgentProfile.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    rows = await db.execute(stmt)
    items = list(rows.scalars())
    return AgentProfileList(items=items, total=total)


@router.get("/{profile_id}", response_model=AgentProfileRead)
async def get_profile(
    profile_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(AgentProfile, profile_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Profile not found")
    return obj


@router.patch("/{profile_id}", response_model=AgentProfileRead)
async def update_profile(
    profile_id: str,
    body: AgentProfileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(AgentProfile, profile_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Profile not found")

    patch = body.model_dump(exclude_unset=True)
    patch = _apply_agent_type_defaults(patch) if patch.get("agent_type") == "story" else patch

    if patch.get("is_default"):
        await _clear_default(db, user.id)

    for key, value in patch.items():
        setattr(obj, key, value)

    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(AgentProfile, profile_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Profile not found")
    await db.delete(obj)
    await db.commit()


@router.post("/{profile_id}/set-default", response_model=AgentProfileRead)
async def set_default(
    profile_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(AgentProfile, profile_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Profile not found")

    await _clear_default(db, user.id)
    obj.is_default = True
    await db.commit()
    await db.refresh(obj)
    return obj
