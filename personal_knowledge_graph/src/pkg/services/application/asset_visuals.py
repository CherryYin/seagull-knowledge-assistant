import re
from copy import deepcopy
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.models.application.asset import Asset, AssetVisual
from pkg.schemas.application.asset import AssetVisualGenerateRequest, AssetVisualRead
from pkg.services.cross_cutting.storage import get_storage_service
from pkg.services.foundation.image_generation import generate_qwen_image


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
) -> AssetVisualRead:
    asset = await _owned_asset(session, user_id=user_id, asset_id=asset_id)
    prompt = (body.prompt or "").strip() or _default_cover_prompt(asset)
    visual = AssetVisual(
        id=f"visual-{uuid4().hex}",
        asset_id=asset.id,
        user_id=user_id,
        role=body.role,
        status="generating",
        prompt=prompt,
        model=settings.QWEN_IMAGE_MODEL,
        metadata_={"size": body.size, "provider": "dashscope"},
    )
    session.add(visual)
    await session.commit()
    await session.refresh(visual)

    try:
        generated = await generate_qwen_image(prompt=prompt, size=body.size)
        extension = _file_extension(generated.content_type)
        safe_role = re.sub(r"[^a-z0-9_-]+", "-", body.role.lower()).strip("-") or "visual"
        object_key = get_storage_service().build_object_key(
            "asset-visuals",
            asset.id,
            f"{safe_role}-{visual.id}{extension}",
        )
        visual.file_path = await get_storage_service().upload_bytes(
            object_key=object_key,
            data=generated.payload,
            content_type=generated.content_type,
        )
        visual.mime_type = generated.content_type
        visual.width = generated.width
        visual.height = generated.height
        visual.provider_request_id = generated.provider_request_id
        visual.metadata_ = {
            **(visual.metadata_ or {}),
            "source_host": generated.source_host,
        }
        visual.status = "ready"
        visual.error_message = None
        await session.commit()
        await session.refresh(visual)
    except Exception as exc:
        visual.status = "failed"
        visual.error_message = str(exc)[:2000]
        await session.commit()
        raise
    return await _visual_read(visual)


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
    if visual.file_path:
        await get_storage_service().delete_object(visual.file_path)
    metadata = deepcopy(asset.metadata_ or {})
    if metadata.get("cover_visual_id") == visual.id:
        metadata.pop("cover_visual_id", None)
        asset.metadata_ = metadata or None
    await session.delete(visual)
    await session.commit()
