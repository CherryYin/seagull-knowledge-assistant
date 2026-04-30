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


def _get_available_tool_names() -> list[str]:
    from pkg.services.action_agent import _BASE_TOOLS

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


@router.get("/available-tools")
async def available_tools(_user: User = Depends(get_current_user)) -> list[str]:
    return _get_available_tool_names()


@router.get("/allowed-models")
async def allowed_models(_user: User = Depends(get_current_user)) -> list[str]:
    return settings.ALLOWED_MODELS


@router.post("", response_model=AgentProfileRead, status_code=201)
async def create_profile(
    body: AgentProfileCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    if body.model_id and body.model_id not in settings.ALLOWED_MODELS:
        raise HTTPException(status_code=422, detail=f"Model '{body.model_id}' not in allowed models")

    if body.is_default:
        await _clear_default(db, user.id)

    profile = AgentProfile(user_id=user.id, **body.model_dump())
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

    if "model_id" in patch and patch["model_id"] and patch["model_id"] not in settings.ALLOWED_MODELS:
        raise HTTPException(status_code=422, detail=f"Model '{patch['model_id']}' not in allowed models")

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
