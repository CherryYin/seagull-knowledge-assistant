import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_admin_user, get_current_user
from pkg.db import get_session
from pkg.models.user import ActivityLog, User, UserMemory, UserSettings
from pkg.schemas.user import (
    ActivityRead,
    ChangePasswordRequest,
    LoginRequest,
    MemoryRead,
    MemoryWrite,
    SettingsRead,
    SettingsUpdate,
    TokenResponse,
    UserCreate,
    UserRead,
    UserUpdate,
)
from pkg.services.auth import create_access_token, hash_password, verify_password

router = APIRouter()


# --- Public ---


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, session: AsyncSession = Depends(get_session)):
    stmt = select(User).where(User.username == body.username)
    result = await session.execute(stmt)
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is disabled",
        )
    token = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token)


# --- Authenticated ---


@router.get("/me", response_model=UserRead)
async def get_me(user: User = Depends(get_current_user)):
    return user


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if not verify_password(body.old_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Old password is incorrect")
    user.hashed_password = hash_password(body.new_password)
    await session.commit()
    return {"detail": "Password changed"}


# --- Admin only ---


@router.get("/users", response_model=list[UserRead])
async def list_users(
    _admin: User = Depends(get_admin_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).order_by(User.created_at.desc()))
    return list(result.scalars())


@router.post("/users", response_model=UserRead, status_code=201)
async def create_user(
    body: UserCreate,
    _admin: User = Depends(get_admin_user),
    session: AsyncSession = Depends(get_session),
):
    # Check uniqueness
    existing = await session.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already exists")

    user = User(
        id=str(uuid.uuid4()),
        username=body.username,
        display_name=body.display_name,
        email=body.email,
        hashed_password=hash_password(body.password),
        role=body.role,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: str,
    body: UserUpdate,
    _admin: User = Depends(get_admin_user),
    session: AsyncSession = Depends(get_session),
):
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    await session.commit()
    await session.refresh(user)
    return user


# --- Memory ---


@router.get("/me/memory", response_model=list[MemoryRead])
async def list_memories(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(UserMemory).where(UserMemory.user_id == user.id).order_by(UserMemory.key)
    )
    return list(result.scalars())


@router.get("/me/memory/{key}", response_model=MemoryRead)
async def get_memory(
    key: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(UserMemory).where(UserMemory.user_id == user.id, UserMemory.key == key)
    )
    mem = result.scalar_one_or_none()
    if not mem:
        raise HTTPException(status_code=404, detail="Memory key not found")
    return mem


@router.put("/me/memory/{key}", response_model=MemoryRead)
async def upsert_memory(
    key: str,
    body: MemoryWrite,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(UserMemory).where(UserMemory.user_id == user.id, UserMemory.key == key)
    )
    mem = result.scalar_one_or_none()
    if mem:
        mem.value = body.value
    else:
        mem = UserMemory(user_id=user.id, key=key, value=body.value)
        session.add(mem)
    await session.commit()
    await session.refresh(mem)
    return mem


@router.delete("/me/memory/{key}", status_code=204)
async def delete_memory(
    key: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(UserMemory).where(UserMemory.user_id == user.id, UserMemory.key == key)
    )
    mem = result.scalar_one_or_none()
    if not mem:
        raise HTTPException(status_code=404, detail="Memory key not found")
    await session.delete(mem)
    await session.commit()


# --- Settings ---


@router.get("/me/settings", response_model=SettingsRead)
async def get_settings(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    obj = await session.get(UserSettings, user.id)
    if not obj:
        return SettingsRead(settings={}, updated_at=user.created_at)
    return obj


@router.patch("/me/settings", response_model=SettingsRead)
async def update_settings(
    body: SettingsUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    obj = await session.get(UserSettings, user.id)
    if not obj:
        obj = UserSettings(user_id=user.id, settings=body.settings)
        session.add(obj)
    else:
        # Merge new settings into existing
        merged = {**obj.settings, **body.settings}
        obj.settings = merged
    await session.commit()
    await session.refresh(obj)
    return obj


# --- Activity Log ---


@router.post("/me/profile/generate")
async def generate_profile(user: User = Depends(get_current_user)):
    from pkg.services.user_profiler import generate_user_profile

    profile = await generate_user_profile(user.id)
    if profile is None:
        raise HTTPException(status_code=422, detail="Insufficient data to generate profile")
    return {"detail": "Profile generated", "profile": profile}


@router.get("/me/activity", response_model=list[ActivityRead])
async def list_activity(
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(ActivityLog)
        .where(ActivityLog.user_id == user.id)
        .order_by(ActivityLog.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    return list(result.scalars())
