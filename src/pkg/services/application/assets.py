import uuid
from copy import deepcopy
from datetime import datetime, timezone
import logging

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.schemas.application.asset import (
    AssetCreate,
    AssetForkRequest,
    AssetKnowledgeLineageItem,
    AssetKnowledgeLineageList,
    AssetProvenance,
    AssetUpdate,
)
from pkg.services.application.blog_generation import check_readiness
from pkg.services.application.production_memory import record_asset_production_event

ALLOWED_ASSET_STATUSES = {"draft", "in_review", "ready_to_export", "exported", "published", "archived"}
WORKSPACE_METADATA_KEY = "asset_workspace_v1"

logger = logging.getLogger(__name__)


def _preserve_workspace_metadata(current_metadata: dict, candidate_metadata: dict) -> dict:
    metadata = deepcopy(candidate_metadata)
    if WORKSPACE_METADATA_KEY in current_metadata:
        metadata[WORKSPACE_METADATA_KEY] = deepcopy(current_metadata[WORKSPACE_METADATA_KEY])
    else:
        metadata.pop(WORKSPACE_METADATA_KEY, None)
    return metadata


def _validate_asset_document_claim_refs(*, current_metadata: dict, candidate_metadata: dict) -> None:
    document = candidate_metadata.get("asset_document")
    if not isinstance(document, dict):
        return
    blocks = document.get("blocks")
    if not isinstance(blocks, list):
        return
    workspace = current_metadata.get(WORKSPACE_METADATA_KEY)
    claims = workspace.get("claims", []) if isinstance(workspace, dict) else []
    claim_statuses = {
        claim.get("id"): claim.get("status")
        for claim in claims
        if isinstance(claim, dict) and isinstance(claim.get("id"), str)
    }
    invalid_refs: set[str] = set()
    for block in blocks:
        if not isinstance(block, dict):
            continue
        claim_refs = block.get("claim_refs", block.get("claimRefs", []))
        if not isinstance(claim_refs, list) or any(not isinstance(claim_id, str) or not claim_id.strip() for claim_id in claim_refs):
            raise HTTPException(status_code=422, detail="Asset Block claim_refs must be an array of non-empty Claim IDs")
        invalid_refs.update(
            claim_id
            for claim_id in claim_refs
            if claim_statuses.get(claim_id) not in {"accepted", "hypothesis"}
        )
    if invalid_refs:
        raise HTTPException(
            status_code=409,
            detail=f"Asset Blocks may only reference accepted Claims or retained Hypotheses: {', '.join(sorted(invalid_refs))}",
        )


def make_asset_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    suffix = uuid.uuid4().hex[:8]
    slug = title[:30].lower().replace(" ", "-")
    return f"asset-{now.strftime('%Y%m%d')}-{slug}-{suffix}"


async def _validate_refs(session: AsyncSession, *, user_id: str, source_refs: list[str], note_refs: list[str], wiki_refs: list[str]) -> None:
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
    await _ensure_all(WikiPage, wiki_refs, "wiki")


async def create_asset(session: AsyncSession, *, user_id: str, body: AssetCreate) -> Asset:
    await _validate_refs(
        session,
        user_id=user_id,
        source_refs=body.source_refs,
        note_refs=body.note_refs,
        wiki_refs=body.wiki_refs,
    )
    metadata = deepcopy(body.metadata or {})
    metadata.pop(WORKSPACE_METADATA_KEY, None)
    _validate_asset_document_claim_refs(current_metadata={}, candidate_metadata=metadata)
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
        outline=body.outline,
        draft_content=body.draft_content,
        source_refs=body.source_refs,
        note_refs=body.note_refs,
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


async def fork_asset(session: AsyncSession, *, user_id: str, asset_id: str, body: AssetForkRequest) -> Asset:
    source = await get_asset(session, user_id=user_id, asset_id=asset_id)
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Fork title must not be blank")
    metadata = {
        "forked_from": {
            "asset_id": source.id,
            "asset_title": source.title,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    }
    source_metadata = source.metadata_ or {}
    for key in ("audience", "delivery_format", "research_mode"):
        if key in source_metadata:
            metadata[key] = deepcopy(source_metadata[key])
    return await create_asset(
        session,
        user_id=user_id,
        body=AssetCreate(
            title=title,
            brief=body.brief.strip() if body.brief and body.brief.strip() else source.brief,
            asset_type=source.asset_type,
            status="draft",
            source_refs=list(source.source_refs or []),
            note_refs=list(source.note_refs or []),
            wiki_refs=list(source.wiki_refs or []),
            opinion_notes=getattr(source, "opinion_notes", None),
            style_notes=getattr(source, "style_notes", None),
            metadata=metadata,
            provenance=AssetProvenance(origin_type="user", origin_ref=source.id, action="save"),
        ),
    )


async def list_assets(session: AsyncSession, *, user_id: str, asset_type: str | None = None, status: str | None = None, limit: int = 50, offset: int = 0) -> tuple[list[Asset], int]:
    filters = [Asset.user_id == user_id]
    if asset_type:
        filters.append(Asset.asset_type == asset_type)
    if status:
        filters.append(Asset.status == status)
    total = (await session.execute(select(func.count()).select_from(Asset).where(*filters))).scalar() or 0
    rows = await session.execute(select(Asset).where(*filters).order_by(Asset.updated_at.desc()).offset(offset).limit(limit))
    return list(rows.scalars()), total


async def list_asset_knowledge_lineage(
    session: AsyncSession,
    *,
    user_id: str,
    target_type: str,
    target_id: str,
) -> AssetKnowledgeLineageList:
    reference_column = Asset.note_refs if target_type == "note" else Asset.wiki_refs
    rows = await session.execute(
        select(Asset)
        .where(Asset.user_id == user_id, reference_column.contains([target_id]))
        .order_by(Asset.updated_at.desc())
    )
    items: list[AssetKnowledgeLineageItem] = []
    for asset in rows.scalars():
        workspace = (asset.metadata_ or {}).get(WORKSPACE_METADATA_KEY)
        candidates = workspace.get("knowledge_candidates", []) if isinstance(workspace, dict) else []
        contribution = workspace.get("contribution") if isinstance(workspace, dict) else None
        matching_candidates = [
            candidate
            for candidate in candidates
            if isinstance(candidate, dict)
            and candidate.get("status") == "promoted"
            and candidate.get("promoted_target_type") == target_type
            and candidate.get("promoted_target_id") == target_id
        ]
        if not matching_candidates:
            items.append(AssetKnowledgeLineageItem(
                asset_id=asset.id,
                asset_title=asset.title,
                asset_type=asset.asset_type,
                asset_status=asset.status,
                relation="referenced",
            ))
            continue
        for candidate in matching_candidates:
            items.append(AssetKnowledgeLineageItem(
                asset_id=asset.id,
                asset_title=asset.title,
                asset_type=asset.asset_type,
                asset_status=asset.status,
                relation="distilled",
                candidate_id=candidate.get("id"),
                candidate_type=candidate.get("candidate_type"),
                candidate_action=candidate.get("action"),
                claim_refs=candidate.get("claim_refs") or [],
                contribution_summary=contribution.get("summary") if isinstance(contribution, dict) else None,
                promoted_at=candidate.get("promoted_at"),
            ))
    return AssetKnowledgeLineageList(target_type=target_type, target_id=target_id, items=items)


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
        wiki_refs=data.get("wiki_refs", asset.wiki_refs or []),
    )
    current_metadata = deepcopy(asset.metadata_ or {})
    effective_metadata = deepcopy(current_metadata)
    if "metadata" in data:
        effective_metadata = _preserve_workspace_metadata(current_metadata, data["metadata"] or {})
        _validate_asset_document_claim_refs(
            current_metadata=current_metadata,
            candidate_metadata=effective_metadata,
        )
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
        wiki_metadata = getattr(wiki, "metadata_", None)
        for claim in (wiki_metadata or {}).get("claims", []) if isinstance(wiki_metadata, dict) else []:
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
