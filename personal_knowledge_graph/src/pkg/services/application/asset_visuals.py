import asyncio
import logging
import re
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from time import perf_counter
from uuid import uuid4

import httpx
from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.application.asset import Asset, AssetVisual
from pkg.schemas.application.asset import AssetVisualGenerateRequest, AssetVisualRead
from pkg.services.cross_cutting.storage import get_storage_service
from pkg.services.cross_cutting.system_jobs import record_system_event
from pkg.services.foundation.image_generation import generate_qwen_image

logger = logging.getLogger(__name__)


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _default_cover_prompt(asset: Asset) -> str:
    context = " ".join(
        part.strip()
        for part in (asset.title, asset.brief or "", (asset.draft_content or "")[:1200])
        if part and part.strip()
    )
    return (
        "为一篇科技内容创作高质量编辑插画封面。"
        "画面应现代、克制、具有清晰视觉中心，适合 Newsletter 或深度文章头图；"
        "不要出现任何文字、字母、水印、Logo 或界面截图。"
        "使用具有层次的构图和专业出版物风格，避免廉价科幻霓虹效果。\n\n"
        f"内容主题：{context}"
    )


def _file_extension(content_type: str) -> str:
    return {
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/png": ".png",
    }.get(content_type.lower(), ".png")


def _classify_generation_error(exc: Exception, *, stage: str) -> tuple[str, bool]:
    if stage == "storage":
        return "storage_error", True
    if isinstance(exc, httpx.TimeoutException):
        return "provider_timeout", True
    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code
        if status_code in {401, 403}:
            return "provider_auth", False
        if status_code == 402:
            return "provider_quota", False
        if status_code == 429:
            return "provider_rate_limit", True
        if status_code in {400, 422}:
            return "provider_rejected", False
        if status_code >= 500:
            return "provider_unavailable", True
        return "provider_request", False
    if isinstance(exc, httpx.RequestError):
        return "provider_network", True
    message = str(exc).lower()
    if "not configured" in message or "disabled" in message:
        return "configuration_error", False
    if "no image url" in message:
        return "provider_invalid_response", True
    return "provider_error", True


async def _record_visual_event(
    visual: AssetVisual,
    *,
    status: str,
    duration_ms: float,
    error_code: str | None = None,
) -> None:
    try:
        await record_system_event(
            job_type="asset_visual_generation",
            title=f"Generate {visual.role} visual",
            status=status,
            user_id=visual.user_id,
            metadata={
                "asset_visual_id": visual.id,
                "asset_id": visual.asset_id,
                "role": visual.role,
                "model": visual.model,
                "attempts": visual.processing_attempts,
                "error_code": error_code,
            },
            error_message=visual.error_message if status == "failed" else None,
            duration_ms=duration_ms,
        )
    except Exception:
        logger.warning("Failed to record Asset visual System Job for %s", visual.id, exc_info=True)


async def _owned_asset(session: AsyncSession, *, user_id: str, asset_id: str) -> Asset:
    asset = await session.get(Asset, asset_id)
    if asset is None or asset.user_id != user_id:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


async def _visual_read(visual: AssetVisual) -> AssetVisualRead:
    image_url = None
    if visual.file_path:
        image_url = await get_storage_service().generate_download_url(visual.file_path)
    return AssetVisualRead(
        id=visual.id,
        asset_id=visual.asset_id,
        role=visual.role,
        status=visual.status,
        prompt=visual.prompt,
        model=visual.model,
        width=visual.width,
        height=visual.height,
        mime_type=visual.mime_type,
        image_url=image_url,
        provider_request_id=visual.provider_request_id,
        error_message=visual.error_message,
        processing_attempts=visual.processing_attempts or 0,
        next_retry_at=visual.next_retry_at,
        started_at=visual.started_at,
        completed_at=visual.completed_at,
        metadata_=visual.metadata_,
        created_at=visual.created_at,
        updated_at=visual.updated_at,
    )


async def list_asset_visuals(session: AsyncSession, *, user_id: str, asset_id: str) -> list[AssetVisualRead]:
    await _owned_asset(session, user_id=user_id, asset_id=asset_id)
    rows = await session.execute(
        select(AssetVisual)
        .where(AssetVisual.asset_id == asset_id, AssetVisual.user_id == user_id)
        .order_by(AssetVisual.created_at.desc())
    )
    return [await _visual_read(visual) for visual in rows.scalars()]


async def generate_asset_visual(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    body: AssetVisualGenerateRequest,
    auto_accept: bool = False,
) -> AssetVisualRead:
    asset = await _owned_asset(session, user_id=user_id, asset_id=asset_id)
    prompt = (body.prompt or "").strip() or _default_cover_prompt(asset)
    active_rows = await session.execute(
        select(AssetVisual).where(
            AssetVisual.asset_id == asset.id,
            AssetVisual.user_id == user_id,
            AssetVisual.role == body.role,
            AssetVisual.status.in_(("queued", "generating", "retrying")),
        )
    )
    for existing in active_rows.scalars():
        metadata = existing.metadata_ or {}
        if existing.prompt == prompt and metadata.get("size") == body.size:
            return await _visual_read(existing)

    max_active = max(settings.ASSET_VISUAL_MAX_ACTIVE_PER_USER, 0)
    if max_active:
        active_count = (
            await session.execute(
                select(func.count())
                .select_from(AssetVisual)
                .where(
                    AssetVisual.user_id == user_id,
                    AssetVisual.status.in_(("queued", "generating", "retrying")),
                )
            )
        ).scalar() or 0
        if active_count >= max_active:
            raise HTTPException(
                status_code=429,
                detail=f"At most {max_active} image generation tasks may be active at once",
            )

    visual = AssetVisual(
        id=f"visual-{uuid4().hex}",
        asset_id=asset.id,
        user_id=user_id,
        role=body.role,
        status="queued",
        prompt=prompt,
        model=settings.QWEN_IMAGE_MODEL,
        processing_attempts=0,
        metadata_={"size": body.size, "provider": "dashscope", "auto_accept": auto_accept},
    )
    session.add(visual)
    await session.commit()
    await session.refresh(visual)
    return await _visual_read(visual)


async def _claim_visual_batch() -> list[str]:
    if not settings.ASSET_VISUAL_PROCESSING_ENABLED:
        return []
    now = _utc_now_naive()
    stale_before = now - timedelta(seconds=max(settings.ASSET_VISUAL_PROCESSING_STALE_SECONDS, 1))
    async with async_session() as session:
        await session.execute(
            update(AssetVisual)
            .where(
                AssetVisual.status == "generating",
                AssetVisual.started_at < stale_before,
                AssetVisual.processing_attempts < settings.ASSET_VISUAL_PROCESSING_MAX_ATTEMPTS,
            )
            .values(status="retrying", next_retry_at=now, error_message="Recovered stale image generation task")
        )
        await session.execute(
            update(AssetVisual)
            .where(
                AssetVisual.status == "generating",
                AssetVisual.started_at < stale_before,
                AssetVisual.processing_attempts >= settings.ASSET_VISUAL_PROCESSING_MAX_ATTEMPTS,
            )
            .values(status="failed", completed_at=now, error_message="Image generation task exceeded retry limit")
        )
        rows = await session.execute(
            select(AssetVisual)
            .where(
                or_(
                    AssetVisual.status == "queued",
                    and_(AssetVisual.status == "retrying", AssetVisual.next_retry_at <= now),
                )
            )
            .order_by(AssetVisual.created_at.asc())
            .limit(max(settings.ASSET_VISUAL_PROCESSING_BATCH_SIZE, 1))
            .with_for_update(skip_locked=True)
        )
        visuals = list(rows.scalars())
        for visual in visuals:
            visual.status = "generating"
            visual.processing_attempts += 1
            visual.started_at = now
            visual.next_retry_at = None
            visual.error_message = None
        await session.commit()
        return [visual.id for visual in visuals]


async def process_asset_visual(visual_id: str) -> None:
    started = perf_counter()
    async with async_session() as session:
        visual = await session.get(AssetVisual, visual_id)
        if visual is None or visual.status != "generating":
            return
        asset = await session.get(Asset, visual.asset_id)
        if asset is None:
            visual.status = "failed"
            visual.error_message = "Asset no longer exists"
            visual.completed_at = _utc_now_naive()
            await session.commit()
            return
        stage = "provider"
        try:
            metadata = visual.metadata_ or {}
            generated = await generate_qwen_image(prompt=visual.prompt, size=str(metadata.get("size") or "1280*720"))
            extension = _file_extension(generated.content_type)
            safe_role = re.sub(r"[^a-z0-9_-]+", "-", visual.role.lower()).strip("-") or "visual"
            storage = get_storage_service()
            stage = "storage"
            object_key = storage.build_object_key(
                "asset-visuals",
                asset.id,
                f"{safe_role}-{visual.id}{extension}",
            )
            visual.file_path = await storage.upload_bytes(
                object_key=object_key,
                data=generated.payload,
                content_type=generated.content_type,
            )
            visual.mime_type = generated.content_type
            visual.width = generated.width
            visual.height = generated.height
            visual.provider_request_id = generated.provider_request_id
            visual.metadata_ = {
                **metadata,
                "source_host": generated.source_host,
                "error_code": None,
                "error_retryable": None,
                "error_stage": None,
            }
            visual.error_message = None
            visual.completed_at = _utc_now_naive()
            if metadata.get("auto_accept"):
                await session.execute(
                    update(AssetVisual)
                    .where(
                        AssetVisual.asset_id == asset.id,
                        AssetVisual.user_id == visual.user_id,
                        AssetVisual.role == visual.role,
                        AssetVisual.id != visual.id,
                        AssetVisual.status == "accepted",
                    )
                    .values(status="ready")
                )
                visual.status = "accepted"
                asset_metadata = deepcopy(asset.metadata_ or {})
                asset_metadata["cover_visual_id"] = visual.id
                asset.metadata_ = asset_metadata
            else:
                visual.status = "ready"
            await session.commit()
            await _record_visual_event(
                visual,
                status="completed",
                duration_ms=round((perf_counter() - started) * 1000, 2),
            )
        except Exception as exc:
            await session.rollback()
            visual = await session.get(AssetVisual, visual_id)
            if visual is None:
                return
            error_code, retryable = _classify_generation_error(exc, stage=stage)
            visual.error_message = str(exc)[:2000]
            visual.metadata_ = {
                **(visual.metadata_ or {}),
                "error_code": error_code,
                "error_retryable": retryable,
                "error_stage": stage,
            }
            if retryable and visual.processing_attempts < settings.ASSET_VISUAL_PROCESSING_MAX_ATTEMPTS:
                multiplier = 2 ** max(visual.processing_attempts - 1, 0)
                visual.status = "retrying"
                visual.next_retry_at = _utc_now_naive() + timedelta(
                    seconds=settings.ASSET_VISUAL_PROCESSING_RETRY_DELAY_SECONDS * multiplier
                )
            else:
                visual.status = "failed"
                visual.completed_at = _utc_now_naive()
                visual.next_retry_at = None
            await session.commit()
            if visual.status == "failed":
                await _record_visual_event(
                    visual,
                    status="failed",
                    error_code=error_code,
                    duration_ms=round((perf_counter() - started) * 1000, 2),
                )
            logger.warning("Asset visual generation failed for %s", visual_id, exc_info=True)


async def asset_visual_processing_loop() -> None:
    while True:
        try:
            for visual_id in await _claim_visual_batch():
                await process_asset_visual(visual_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Asset visual processing loop iteration failed")
        await asyncio.sleep(max(settings.ASSET_VISUAL_PROCESSING_INTERVAL_SECONDS, 1))


async def decide_asset_visual(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    visual_id: str,
    decision: str,
) -> AssetVisualRead:
    asset = await _owned_asset(session, user_id=user_id, asset_id=asset_id)
    visual = await session.get(AssetVisual, visual_id)
    if visual is None or visual.asset_id != asset.id or visual.user_id != user_id:
        raise HTTPException(status_code=404, detail="Asset visual not found")
    if visual.status not in {"ready", "accepted", "rejected"}:
        raise HTTPException(status_code=409, detail="Asset visual is not ready for review")

    if decision == "accept":
        await session.execute(
            update(AssetVisual)
            .where(
                AssetVisual.asset_id == asset.id,
                AssetVisual.user_id == user_id,
                AssetVisual.role == visual.role,
                AssetVisual.id != visual.id,
                AssetVisual.status == "accepted",
            )
            .values(status="ready")
        )
        visual.status = "accepted"
        metadata = deepcopy(asset.metadata_ or {})
        metadata["cover_visual_id"] = visual.id
        asset.metadata_ = metadata
    else:
        visual.status = "rejected"
        metadata = deepcopy(asset.metadata_ or {})
        if metadata.get("cover_visual_id") == visual.id:
            metadata.pop("cover_visual_id", None)
        asset.metadata_ = metadata or None
    await session.commit()
    await session.refresh(visual)
    return await _visual_read(visual)


async def cancel_asset_visual(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    visual_id: str,
) -> AssetVisualRead:
    await _owned_asset(session, user_id=user_id, asset_id=asset_id)
    visual = await session.get(AssetVisual, visual_id)
    if visual is None or visual.asset_id != asset_id or visual.user_id != user_id:
        raise HTTPException(status_code=404, detail="Asset visual not found")
    if visual.status not in {"queued", "retrying"}:
        raise HTTPException(status_code=409, detail="Only queued or retrying visuals can be cancelled")
    visual.status = "cancelled"
    visual.next_retry_at = None
    visual.completed_at = _utc_now_naive()
    await session.commit()
    await session.refresh(visual)
    return await _visual_read(visual)


async def delete_asset_visual(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    visual_id: str,
) -> None:
    asset = await _owned_asset(session, user_id=user_id, asset_id=asset_id)
    visual = await session.get(AssetVisual, visual_id)
    if visual is None or visual.asset_id != asset.id or visual.user_id != user_id:
        raise HTTPException(status_code=404, detail="Asset visual not found")
    if visual.status == "generating":
        raise HTTPException(status_code=409, detail="Generating visual cannot be deleted")
    if visual.file_path:
        await get_storage_service().delete_object(visual.file_path)
    metadata = deepcopy(asset.metadata_ or {})
    if metadata.get("cover_visual_id") == visual.id:
        metadata.pop("cover_visual_id", None)
        asset.metadata_ = metadata or None
    await session.delete(visual)
    await session.commit()
