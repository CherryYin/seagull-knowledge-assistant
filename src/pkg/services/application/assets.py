import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.schemas.application.asset import AssetCreate, AssetUpdate
from pkg.services.application.blog_generation import check_readiness

ALLOWED_ASSET_STATUSES = {"draft", "in_review", "ready_to_export", "exported", "published", "archived"}


def make_asset_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    suffix = uuid.uuid4().hex[:8]
    slug = title[:30].lower().replace(" ", "-")
    return f"asset-{now.strftime('%Y%m%d')}-{slug}-{suffix}"


async def _validate_refs(session: AsyncSession, *, user_id: str, source_refs: list[str], note_refs: list[str], memory_refs: list[str], wiki_refs: list[str]) -> None:
    async def _ensure_all(model, ids: list[str], label: str) -> None:
        if not ids:
            return
        rows = await session.execute(select(model.id).where(model.user_id == user_id, model.id.in_(ids)))
        found = set(rows.scalars())
        missing = [item for item in ids if item not in found]
        if missing:
            raise HTTPException(status_code=404, detail=f"Unknown {label} refs: {', '.join(missing)}")

    await _ensure_all(Source, source_refs, "source")
    await _ensure_all(Note, note_refs, "note")
    await _ensure_all(MemoryNode, memory_refs, "memory")
    await _ensure_all(WikiPage, wiki_refs, "wiki")


async def create_asset(session: AsyncSession, *, user_id: str, body: AssetCreate) -> Asset:
    await _validate_refs(
        session,
        user_id=user_id,
        source_refs=body.source_refs,
        note_refs=body.note_refs,
        memory_refs=body.memory_refs,
        wiki_refs=body.wiki_refs,
    )
    metadata = dict(body.metadata or {})
    if body.opinion_notes is not None:
        metadata["opinion_notes"] = body.opinion_notes
    if body.style_notes is not None:
        metadata["style_notes"] = body.style_notes
    asset = Asset(
        id=make_asset_id(body.title),
        user_id=user_id,
        asset_type=body.asset_type,
        status=body.status,
        title=body.title,
        brief=body.brief,
        source_refs=body.source_refs,
        note_refs=body.note_refs,
        memory_refs=body.memory_refs,
        wiki_refs=body.wiki_refs,
        metadata_=metadata or None,
    )
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    return asset


async def list_assets(session: AsyncSession, *, user_id: str, asset_type: str | None = None, status: str | None = None, limit: int = 50, offset: int = 0) -> tuple[list[Asset], int]:
    filters = [Asset.user_id == user_id]
    if asset_type:
        filters.append(Asset.asset_type == asset_type)
    if status:
        filters.append(Asset.status == status)
    total = (await session.execute(select(func.count()).select_from(Asset).where(*filters))).scalar() or 0
    rows = await session.execute(select(Asset).where(*filters).order_by(Asset.updated_at.desc()).offset(offset).limit(limit))
    return list(rows.scalars()), total


async def get_asset(session: AsyncSession, *, user_id: str, asset_id: str) -> Asset:
    row = await session.execute(select(Asset).where(Asset.id == asset_id, Asset.user_id == user_id))
    asset = row.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    metadata = dict(asset.metadata_ or {})
    setattr(asset, "opinion_notes", metadata.get("opinion_notes"))
    setattr(asset, "style_notes", metadata.get("style_notes"))
    return asset


async def update_asset(session: AsyncSession, *, user_id: str, asset_id: str, body: AssetUpdate) -> Asset:
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id)
    data = body.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in ALLOWED_ASSET_STATUSES:
        raise HTTPException(status_code=400, detail="Unsupported asset status")
    await _validate_refs(
        session,
        user_id=user_id,
        source_refs=data.get("source_refs", asset.source_refs or []),
        note_refs=data.get("note_refs", asset.note_refs or []),
        memory_refs=data.get("memory_refs", asset.memory_refs or []),
        wiki_refs=data.get("wiki_refs", asset.wiki_refs or []),
    )
    if data.get("status") == "ready_to_export":
        candidate = Asset(
            id=asset.id,
            user_id=asset.user_id,
            asset_type=asset.asset_type,
            status="ready_to_export",
            title=data.get("title", asset.title),
            brief=data.get("brief", asset.brief),
            outline=data.get("outline", asset.outline),
            draft_content=data.get("draft_content", asset.draft_content),
            reference_notes=data.get("reference_notes", asset.reference_notes),
            editor_feedback=data.get("editor_feedback", asset.editor_feedback),
            source_refs=data.get("source_refs", asset.source_refs),
            note_refs=data.get("note_refs", asset.note_refs),
            memory_refs=data.get("memory_refs", asset.memory_refs),
            wiki_refs=data.get("wiki_refs", asset.wiki_refs),
            export_format=data.get("export_format", asset.export_format),
            metadata_=dict(asset.metadata_ or {}),
        )
        if "opinion_notes" in data:
            candidate.metadata_["opinion_notes"] = data["opinion_notes"]
        if "style_notes" in data:
            candidate.metadata_["style_notes"] = data["style_notes"]
        ready, blocking_reasons, _, _ = check_readiness(candidate)
        if not ready:
            raise HTTPException(
                status_code=409,
                detail="Asset is not ready to export: " + "; ".join(blocking_reasons),
            )
    for key, value in data.items():
        if key in {"metadata", "opinion_notes", "style_notes"}:
            metadata = dict(asset.metadata_ or {})
            if key == "metadata":
                metadata = dict(value or {})
            else:
                metadata[key] = value
            setattr(asset, "metadata_", metadata)
        else:
            setattr(asset, key, value)
    await session.commit()
    await session.refresh(asset)
    metadata = dict(asset.metadata_ or {})
    setattr(asset, "opinion_notes", metadata.get("opinion_notes"))
    setattr(asset, "style_notes", metadata.get("style_notes"))
    return asset
