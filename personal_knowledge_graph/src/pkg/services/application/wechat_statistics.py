import hashlib
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.wechat_statistics import WechatStatisticsSnapshot
from pkg.models.user_api_credential import UserApiCredential
from pkg.schemas.application.wechat_statistics import WechatStatisticsRead, WechatStatisticsRequest
from pkg.services.cross_cutting.credentials_crypto import CredentialsCryptoError, decrypt_secret
from pkg.services.cross_cutting.user_api_credentials import get_user_api_credential
from pkg.services.foundation.wechat_statistics import WechatStatisticsError, fetch_article_statistics


async def _account(session, *, user_id, credential_id, lock=False):
    if lock:
        credential = (await session.execute(select(UserApiCredential).where(
            UserApiCredential.id == credential_id, UserApiCredential.user_id == user_id,
        ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    else:
        credential = await get_user_api_credential(session, user_id=user_id, credential_id=credential_id)
    if credential is None:
        raise HTTPException(status_code=404, detail="公众号凭据不存在")
    if credential.provider != "wechat_official_account" or not credential.is_enabled:
        raise HTTPException(status_code=409, detail="请选择已启用的微信公众号凭据")
    app_id = str((credential.config or {}).get("app_id") or "").strip()
    if not app_id:
        raise HTTPException(status_code=409, detail="请先在 Settings → API Keys 中填写公众号 AppID")
    return credential, app_id, hashlib.sha256(app_id.encode()).hexdigest()


def _read(snapshot):
    return WechatStatisticsRead(
        id=snapshot.id, credential_id=snapshot.credential_id, publication_date=snapshot.publication_date,
        fetched_at=snapshot.fetched_at, data=snapshot.payload,
    )


async def get_statistics(session: AsyncSession, *, user_id: str, body: WechatStatisticsRequest):
    credential, app_id, account_hash = await _account(session, user_id=user_id, credential_id=body.credential_id)
    try:
        snapshot = (await session.execute(select(WechatStatisticsSnapshot).where(
            WechatStatisticsSnapshot.user_id == user_id, WechatStatisticsSnapshot.credential_id == credential.id,
            WechatStatisticsSnapshot.account_hash == account_hash, WechatStatisticsSnapshot.publication_date == body.publication_date,
        ).order_by(WechatStatisticsSnapshot.fetched_at.desc(), WechatStatisticsSnapshot.id.desc()).limit(1))).scalar_one_or_none()
    except ProgrammingError as error:
        if getattr(error.orig, "sqlstate", None) == "42P01":
            await session.rollback()
            raise HTTPException(status_code=503, detail="公众号统计表尚未迁移，请在 personal_knowledge_graph 运行 .venv/bin/alembic upgrade head 并重启 PKG") from None
        raise
    return _read(snapshot) if snapshot else None


async def sync_statistics(session: AsyncSession, *, user_id: str, body: WechatStatisticsRequest):
    credential, app_id, account_hash = await _account(session, user_id=user_id, credential_id=body.credential_id)
    try:
        secret = decrypt_secret(credential.secret_encrypted)
    except CredentialsCryptoError:
        raise HTTPException(status_code=409, detail="无法解密公众号凭据，请检查服务端加密配置或重新保存 AppSecret") from None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30), follow_redirects=False) as client:
            payload = await fetch_article_statistics(app_id=app_id, app_secret=secret, publication_date=body.publication_date, client=client)
    except WechatStatisticsError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from None
    current, current_app_id, current_hash = await _account(session, user_id=user_id, credential_id=body.credential_id, lock=True)
    if current_hash != account_hash:
        raise HTTPException(status_code=409, detail="公众号配置已变化，请重新选择账号并同步")
    snapshot = WechatStatisticsSnapshot(
        id=str(uuid.uuid4()), user_id=user_id, credential_id=credential.id, account_hash=account_hash,
        publication_date=body.publication_date, fetched_at=datetime.now(timezone.utc), payload=payload.model_dump(mode="json"),
    )
    session.add(snapshot)
    try:
        await session.commit()
    except ProgrammingError as error:
        if getattr(error.orig, "sqlstate", None) == "42P01":
            await session.rollback()
            raise HTTPException(status_code=503, detail="公众号统计表尚未迁移，请在 personal_knowledge_graph 运行 .venv/bin/alembic upgrade head 并重启 PKG") from None
        raise
    return _read(snapshot)
