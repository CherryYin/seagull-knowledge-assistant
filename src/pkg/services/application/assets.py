import uuid
from datetime import datetime, timedelta, timezone
import logging

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.schemas.application.asset import AssetCreate, AssetUpdate, RecentNewsletterCreate
from pkg.services.application.blog_generation import attach_references, check_readiness, generate_draft, generate_outline
from pkg.services.application.production_memory import record_asset_production_event

ALLOWED_ASSET_STATUSES = {"draft", "in_review", "ready_to_export", "exported", "published", "archived"}

logger = logging.getLogger(__name__)


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
    if body.provenance is not None:
        metadata["provenance"] = body.provenance.model_dump(exclude_none=True)
    if body.opinion_notes is not None:
        metadata["opinion_notes"] = body.opinion_notes
    if body.style_notes is not None:
        metadata["style_notes"] = body.style_notes
    metadata = await _inject_wiki_claims_metadata(
        session,
        user_id=user_id,
        wiki_refs=body.wiki_refs,
        metadata=metadata,
    )
    asset = Asset(
        id=make_asset_id(body.title),
        user_id=user_id,
        asset_type=body.asset_type,
        status=body.status,
        title=body.title,
        brief=body.brief,
        draft_content=body.draft_content,
        source_refs=body.source_refs,
        note_refs=body.note_refs,
        memory_refs=body.memory_refs,
        wiki_refs=body.wiki_refs,
        metadata_=metadata or None,
    )
    session.add(asset)
    await session.flush()
    await record_asset_production_event(
        session,
        user_id=user_id,
        asset=asset,
        event_type="asset_generated",
        detail={"source": "create_asset"},
    )
    await session.commit()
    await session.refresh(asset)
    return asset


async def create_recent_newsletter_asset(
    session: AsyncSession,
    *,
    user_id: str,
    body: RecentNewsletterCreate,
) -> Asset:
    window_end = datetime.now(timezone.utc).replace(tzinfo=None)
    window_start = window_end - timedelta(days=body.window_days)
    rows = await session.execute(
        select(Source)
        .where(
            Source.user_id == user_id,
            Source.ingested_at >= window_start,
            Source.ingested_at <= window_end,
        )
        .order_by(Source.ingested_at.desc())
        .limit(body.max_sources)
    )
    sources = list(rows.scalars())
    if not sources:
        raise HTTPException(status_code=404, detail=f"No sources ingested in the past {body.window_days} days")

    brief = body.brief or (
        f"Write a newsletter issue based on sources ingested in the past {body.window_days} days. "
        "Do not require manually selected notes. Use the author's point of view as the editorial frame, "
        "choose the most important themes from the recent sources, and cite the attached source references."
    )
    metadata = {
        "opinion_notes": body.opinion_notes,
        "style_notes": body.style_notes or "",
        "auto_source_window": {
            "kind": "recent_sources",
            "window_days": body.window_days,
            "max_sources": body.max_sources,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "source_count": len(sources),
        },
    }
    asset = await create_asset(
        session,
        user_id=user_id,
        body=AssetCreate(
            title=body.title,
            brief=brief,
            asset_type="newsletter_issue",
            status=body.status,
            source_refs=[source.id for source in sources],
            note_refs=[],
            opinion_notes=body.opinion_notes,
            style_notes=body.style_notes,
            metadata=metadata,
        ),
    )
    asset.outline = await generate_outline(session, asset=asset)
    asset.draft_content = await generate_draft(session, asset=asset)
    asset.reference_notes = await attach_references(session, asset=asset)
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
        logger.warning("Asset not found for user", extra={"asset_id": asset_id, "user_id": user_id})
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
    effective_metadata = dict(asset.metadata_ or {})
    if "metadata" in data:
        effective_metadata = dict(data["metadata"] or {})
    if "opinion_notes" in data:
        effective_metadata["opinion_notes"] = data["opinion_notes"]
    if "style_notes" in data:
        effective_metadata["style_notes"] = data["style_notes"]
    effective_metadata = await _inject_wiki_claims_metadata(
        session,
        user_id=user_id,
        wiki_refs=data.get("wiki_refs", asset.wiki_refs or []),
        metadata=effective_metadata,
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
            metadata_=effective_metadata,
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
                metadata = dict(effective_metadata or value or {})
            else:
                metadata = dict(effective_metadata or metadata)
            setattr(asset, "metadata_", metadata)
        else:
            setattr(asset, key, value)
    if "metadata" not in data and {"wiki_refs", "opinion_notes", "style_notes"}.intersection(data.keys()):
        asset.metadata_ = effective_metadata

    event_type = None
    event_detail = {}
    if data.get("status") == "ready_to_export":
        event_type = "asset_ready_to_export"
    elif data.get("status") == "exported":
        event_type = "asset_exported"
        event_detail = {
            "export_format": data.get("export_format", asset.export_format),
            "channel": data.get("export_format", asset.export_format),
        }
    elif data.get("status") == "published":
        event_type = "asset_published"
        publish_feedback = dict((effective_metadata or {}).get("publish_feedback") or {})
        event_detail = {
            "published_at": data.get("published_at", asset.published_at.isoformat() if asset.published_at else None),
            "channel": publish_feedback.get("channel"),
            "publish_url": publish_feedback.get("publish_url"),
            "feedback": publish_feedback.get("feedback"),
        }
    elif data.get("editor_feedback"):
        event_type = "asset_feedback_recorded"
        event_detail = {"feedback": data.get("editor_feedback")}
    if event_type:
        await record_asset_production_event(
            session,
            user_id=user_id,
            asset=asset,
            event_type=event_type,
            detail=event_detail,
        )
    await session.commit()
    await session.refresh(asset)
    metadata = dict(asset.metadata_ or {})
    setattr(asset, "opinion_notes", metadata.get("opinion_notes"))
    setattr(asset, "style_notes", metadata.get("style_notes"))
    return asset


async def delete_asset(session: AsyncSession, *, user_id: str, asset_id: str) -> None:
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id)
    await session.delete(asset)
    await session.commit()


async def _inject_wiki_claims_metadata(
    session: AsyncSession,
    *,
    user_id: str,
    wiki_refs: list[str],
    metadata: dict,
) -> dict:
    if not wiki_refs:
        metadata.pop("wiki_claims", None)
        return metadata
    rows = await session.execute(select(WikiPage).where(WikiPage.user_id == user_id, WikiPage.id.in_(wiki_refs)))
    wiki_rows = list(rows.scalars())
    claims: list[dict] = []
    for wiki in wiki_rows:
        for claim in (wiki.metadata_ or {}).get("claims", []) if isinstance(wiki.metadata_, dict) else []:
            if not isinstance(claim, dict):
                continue
            enriched = dict(claim)
            enriched.setdefault("wiki_id", wiki.id)
            enriched.setdefault("wiki_title", wiki.title)
            claims.append(enriched)
    if claims:
        metadata["wiki_claims"] = claims
    else:
        metadata.pop("wiki_claims", None)
    return metadata
