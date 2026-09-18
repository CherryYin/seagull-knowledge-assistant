import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
    PublishingSettingsRead,
    PublishingSettingsUpdate,
    RegisterRequest,
    RegisterResponse,
    SettingsRead,
    SettingsUpdate,
    TokenResponse,
    UserCreate,
    UserRead,
    UserUpdate,
    USER_MEMORY_TYPE_PATTERN,
)
from pkg.schemas.user_api_credential import (
    UserApiCredentialCreate,
    UserApiCredentialList,
    UserApiCredentialRead,
    UserApiCredentialUpdate,
)
from pkg.services.cross_cutting.auth import create_access_token, hash_password, verify_password
from pkg.services.cross_cutting.credentials_crypto import CredentialsCryptoConfigError, CredentialsCryptoValueError
from pkg.services.cross_cutting.user_api_credentials import (
    create_user_api_credential,
    delete_user_api_credential,
    get_user_api_credential,
    list_user_api_credentials,
    update_user_api_credential,
    UserApiCredentialsStorageUnavailableError,
)

router = APIRouter()

_ALLOWED_ROLES = {"user", "admin"}
_ALLOWED_APPROVAL_STATUSES = {"pending", "approved", "rejected"}


def _raise_api_credential_crypto_error(exc: Exception) -> None:
    if isinstance(exc, CredentialsCryptoConfigError):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, CredentialsCryptoValueError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise exc


def _raise_api_credential_storage_error(exc: UserApiCredentialsStorageUnavailableError) -> None:
    raise HTTPException(status_code=503, detail=str(exc)) from exc


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
    if user.approval_status == "pending":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account registration is pending administrator approval",
        )
    if user.approval_status == "rejected":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account registration was rejected",
        )
    token = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token)


@router.post("/register", response_model=RegisterResponse, status_code=201)
async def register(body: RegisterRequest, session: AsyncSession = Depends(get_session)):
    existing = await session.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already exists")

    user = User(
        id=str(uuid.uuid4()),
        username=body.username,
        display_name=body.display_name,
        email=body.email,
        hashed_password=hash_password(body.password),
        role="user",
        approval_status="pending",
        is_active=True,
    )
    session.add(user)
    await session.commit()
    return RegisterResponse(
        detail="Registration submitted. Please wait for administrator approval before signing in.",
        approval_status="pending",
    )


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
        approval_status="approved",
        is_active=True,
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
    updates = body.model_dump(exclude_unset=True)
    if "role" in updates and updates["role"] not in _ALLOWED_ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of: {', '.join(_ALLOWED_ROLES)}")
    if "approval_status" in updates and updates["approval_status"] not in _ALLOWED_APPROVAL_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"approval_status must be one of: {', '.join(_ALLOWED_APPROVAL_STATUSES)}",
        )
    for field, value in updates.items():
        setattr(user, field, value)
    await session.commit()
    await session.refresh(user)
    return user


# --- Memory ---


@router.get("/me/memory", response_model=list[MemoryRead])
async def list_memories(
    memory_type: str | None = Query(default=None, pattern=USER_MEMORY_TYPE_PATTERN),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(UserMemory).where(UserMemory.user_id == user.id)
    if memory_type:
        stmt = stmt.where(UserMemory.memory_type == memory_type)
    result = await session.execute(stmt.order_by(UserMemory.memory_type, UserMemory.key))
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
        mem.memory_type = body.memory_type
        mem.value = body.value
    else:
        mem = UserMemory(user_id=user.id, key=key, memory_type=body.memory_type, value=body.value)
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


@router.get("/me/settings/publishing", response_model=PublishingSettingsRead)
async def get_publishing_settings(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    obj = await session.get(UserSettings, user.id)
    publishing = obj.settings.get("publishing", {}) if obj and isinstance(obj.settings, dict) else {}
    return PublishingSettingsRead(
        primary_site_url=str(publishing.get("primary_site_url") or ""),
        default_channel=str(publishing.get("default_channel") or ""),
        updated_at=obj.updated_at if obj else user.created_at,
    )


@router.patch("/me/settings/publishing", response_model=PublishingSettingsRead)
async def update_publishing_settings(
    body: PublishingSettingsUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    obj = await session.get(UserSettings, user.id)
    existing_settings = dict(obj.settings) if obj and isinstance(obj.settings, dict) else {}
    publishing = dict(existing_settings.get("publishing") or {})
    publishing.update(body.model_dump(exclude_none=True))
    existing_settings["publishing"] = publishing
    if not obj:
        obj = UserSettings(user_id=user.id, settings=existing_settings)
        session.add(obj)
    else:
        obj.settings = existing_settings
    await session.commit()
    await session.refresh(obj)
    return PublishingSettingsRead(
        primary_site_url=str(publishing.get("primary_site_url") or ""),
        default_channel=str(publishing.get("default_channel") or ""),
        updated_at=obj.updated_at,
    )


@router.get("/me/api-credentials", response_model=UserApiCredentialList)
async def list_api_credentials(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    items = await list_user_api_credentials(session, user_id=user.id)
    return UserApiCredentialList(items=[UserApiCredentialRead.model_validate(item) for item in items], total=len(items))


@router.post("/me/api-credentials", response_model=UserApiCredentialRead, status_code=201)
async def create_api_credential(
    body: UserApiCredentialCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        item = await create_user_api_credential(session, user_id=user.id, body=body)
    except (CredentialsCryptoConfigError, CredentialsCryptoValueError) as exc:
        await session.rollback()
        _raise_api_credential_crypto_error(exc)
    except UserApiCredentialsStorageUnavailableError as exc:
        _raise_api_credential_storage_error(exc)
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return UserApiCredentialRead.model_validate(item)


@router.get("/me/api-credentials/{credential_id}", response_model=UserApiCredentialRead)
async def get_api_credential(
    credential_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    item = await get_user_api_credential(session, user_id=user.id, credential_id=credential_id)
    if item is None:
        raise HTTPException(status_code=404, detail="API credential not found")
    return UserApiCredentialRead.model_validate(item)


@router.patch("/me/api-credentials/{credential_id}", response_model=UserApiCredentialRead)
async def patch_api_credential(
    credential_id: int,
    body: UserApiCredentialUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        item = await update_user_api_credential(session, user_id=user.id, credential_id=credential_id, body=body)
    except (CredentialsCryptoConfigError, CredentialsCryptoValueError) as exc:
        await session.rollback()
        _raise_api_credential_crypto_error(exc)
    except UserApiCredentialsStorageUnavailableError as exc:
        _raise_api_credential_storage_error(exc)
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="API credential not found")
    return UserApiCredentialRead.model_validate(item)


@router.delete("/me/api-credentials/{credential_id}", status_code=204)
async def remove_api_credential(
    credential_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    deleted = await delete_user_api_credential(session, user_id=user.id, credential_id=credential_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="API credential not found")


# --- Activity Log ---


@router.post("/me/profile/generate")
async def generate_profile(user: User = Depends(get_current_user)):
    from pkg.services.cross_cutting.user_profiler import generate_user_profile

    profile = await generate_user_profile(user.id)
    if profile is None:
        raise HTTPException(status_code=422, detail="Insufficient data to generate profile")
    return {"detail": "Profile generated", "profile": profile}


@router.get("/me/activity", response_model=list[ActivityRead])
async def list_activity(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
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
