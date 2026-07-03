from __future__ import annotations

import logging

from sqlalchemy.exc import ProgrammingError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.user_api_credential import UserApiCredential
from pkg.schemas.user_api_credential import UserApiCredentialCreate, UserApiCredentialUpdate
from pkg.services.cross_cutting.credentials_crypto import encrypt_secret, mask_secret
from pkg.services.cross_cutting.credentials_crypto import decrypt_secret

logger = logging.getLogger(__name__)


async def _clear_other_defaults(session: AsyncSession, *, user_id: str, provider: str, keep_id: int | None = None) -> None:
    rows = await session.execute(
        select(UserApiCredential).where(
            UserApiCredential.user_id == user_id,
            UserApiCredential.provider == provider,
            UserApiCredential.is_default.is_(True),
        )
    )
    for item in rows.scalars():
        if keep_id is not None and item.id == keep_id:
            continue
        item.is_default = False


async def create_user_api_credential(session: AsyncSession, *, user_id: str, body: UserApiCredentialCreate) -> UserApiCredential:
    credential = UserApiCredential(
        user_id=user_id,
        provider=body.provider,
        label=body.label,
        secret_encrypted=encrypt_secret(body.secret),
        secret_masked=mask_secret(body.secret),
        config=body.config,
        is_enabled=body.is_enabled,
        is_default=body.is_default,
    )
    session.add(credential)
    try:
        await session.flush()
    except ProgrammingError as exc:
        await session.rollback()
        if _is_missing_user_api_credentials_table(exc):
            raise UserApiCredentialsStorageUnavailableError("User API credentials table is missing; run database migrations") from exc
        raise
    if credential.is_default:
        await _clear_other_defaults(session, user_id=user_id, provider=credential.provider, keep_id=credential.id)
    await session.commit()
    await session.refresh(credential)
    return credential


async def list_user_api_credentials(session: AsyncSession, *, user_id: str) -> list[UserApiCredential]:
    try:
        rows = await session.execute(
            select(UserApiCredential)
            .where(UserApiCredential.user_id == user_id)
            .order_by(UserApiCredential.provider.asc(), UserApiCredential.label.asc(), UserApiCredential.id.asc())
        )
    except ProgrammingError as exc:
        await session.rollback()
        if _is_missing_user_api_credentials_table(exc):
            logger.warning("User API credentials table is missing; returning an empty credential list")
            return []
        raise
    return list(rows.scalars())


async def get_user_api_credential(session: AsyncSession, *, user_id: str, credential_id: int) -> UserApiCredential | None:
    try:
        credential = await session.get(UserApiCredential, credential_id)
    except ProgrammingError as exc:
        await session.rollback()
        if _is_missing_user_api_credentials_table(exc):
            logger.warning("User API credentials table is missing; returning credential not found")
            return None
        raise
    if not credential or credential.user_id != user_id:
        return None
    return credential


async def update_user_api_credential(session: AsyncSession, *, user_id: str, credential_id: int, body: UserApiCredentialUpdate) -> UserApiCredential | None:
    credential = await get_user_api_credential(session, user_id=user_id, credential_id=credential_id)
    if credential is None:
        return None
    if body.label is not None:
        credential.label = body.label
    if body.secret is not None:
        credential.secret_encrypted = encrypt_secret(body.secret)
        credential.secret_masked = mask_secret(body.secret)
    if body.config is not None:
        credential.config = body.config
    if body.is_enabled is not None:
        credential.is_enabled = body.is_enabled
    if body.is_default is not None:
        credential.is_default = body.is_default
    try:
        await session.flush()
    except ProgrammingError as exc:
        await session.rollback()
        if _is_missing_user_api_credentials_table(exc):
            raise UserApiCredentialsStorageUnavailableError("User API credentials table is missing; run database migrations") from exc
        raise
    if credential.is_default:
        await _clear_other_defaults(session, user_id=user_id, provider=credential.provider, keep_id=credential.id)
    await session.commit()
    await session.refresh(credential)
    return credential


async def delete_user_api_credential(session: AsyncSession, *, user_id: str, credential_id: int) -> bool:
    credential = await get_user_api_credential(session, user_id=user_id, credential_id=credential_id)
    if credential is None:
        return False
    await session.delete(credential)
    await session.commit()
    return True


async def get_default_user_api_credential(session: AsyncSession, *, user_id: str, provider: str) -> UserApiCredential | None:
    rows = await session.execute(
        select(UserApiCredential)
        .where(
            UserApiCredential.user_id == user_id,
            UserApiCredential.provider == provider,
            UserApiCredential.is_enabled.is_(True),
        )
        .order_by(UserApiCredential.is_default.desc(), UserApiCredential.id.asc())
        .limit(1)
    )
    return rows.scalar_one_or_none()


async def get_default_user_api_credential_secret(session: AsyncSession, *, user_id: str, provider: str) -> tuple[str | None, dict]:
    try:
        credential = await get_default_user_api_credential(session, user_id=user_id, provider=provider)
    except ProgrammingError as exc:
        await session.rollback()
        if _is_missing_user_api_credentials_table(exc):
            logger.warning("User API credentials table is missing; falling back to global provider settings")
            return None, {}
        raise
    if credential is None:
        return None, {}
    return decrypt_secret(credential.secret_encrypted), dict(credential.config or {})


def _is_missing_user_api_credentials_table(exc: ProgrammingError) -> bool:
    original = getattr(exc, "orig", None)
    sqlstate = getattr(original, "sqlstate", None) or getattr(original, "pgcode", None)
    if sqlstate == "42P01":
        return True
    return "user_api_credentials" in str(exc) and "does not exist" in str(exc)


class UserApiCredentialsStorageUnavailableError(RuntimeError):
    pass
