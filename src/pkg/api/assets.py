from fastapi import APIRouter, Depends, Query
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.application.asset import (
    AssetCreate,
    AssetExportResult,
    AssetFeedbackNoteResult,
    AssetList,
    AssetPublishFeedbackUpdate,
    AssetRead,
    AssetUpdate,
    AttachReferencesRequest,
    GenerateDraftRequest,
    GenerateOutlineRequest,
    RecentNewsletterCreate,
    ReadinessCheckResult,
)
from pkg.schemas.note import NoteCreate
from pkg.services.application.assets import create_asset, create_recent_newsletter_asset, delete_asset, get_asset, list_assets, update_asset
from pkg.services.application.blog_generation import (
    attach_references,
    check_readiness,
    export_markdown,
    generate_draft,
    generate_outline,
)
from pkg.api.notes import persist_note

router = APIRouter()


@router.post("", response_model=AssetRead)
async def create_asset_route(
    body: AssetCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if (
        body.asset_type == "newsletter_issue"
        and not body.source_refs
        and not body.note_refs
        and not body.wiki_refs
        and body.opinion_notes
    ):
        return await create_recent_newsletter_asset(
            session,
            user_id=user.id,
            body=RecentNewsletterCreate(
                title=body.title,
                brief=body.brief,
                opinion_notes=body.opinion_notes,
                style_notes=body.style_notes,
                status=body.status,
            ),
        )
    asset = await create_asset(session, user_id=user.id, body=body)
    if body.asset_type == "research_brief":
        asset = await update_asset(
            session,
            user_id=user.id,
            asset_id=asset.id,
            body=AssetUpdate(
                outline=await generate_outline(session, asset=asset),
                draft_content=await generate_draft(session, asset=asset),
                reference_notes=await attach_references(session, asset=asset),
            ),
        )
    return asset


@router.post("/newsletter/recent-sources", response_model=AssetRead)
async def create_recent_newsletter_route(
    body: RecentNewsletterCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await create_recent_newsletter_asset(session, user_id=user.id, body=body)


@router.get("", response_model=AssetList)
async def list_assets_route(
    asset_type: str | None = None,
    status: str | None = Query(default=None, pattern=r"^(draft|in_review|ready_to_export|exported|published|archived)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    items, total = await list_assets(session, user_id=user.id, asset_type=asset_type, status=status, limit=limit, offset=offset)
    return AssetList(items=items, total=total)


@router.get("/{asset_id}", response_model=AssetRead)
async def get_asset_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await get_asset(session, user_id=user.id, asset_id=asset_id)


@router.patch("/{asset_id}", response_model=AssetRead)
async def update_asset_route(
    asset_id: str,
    body: AssetUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await update_asset(session, user_id=user.id, asset_id=asset_id, body=body)


@router.delete("/{asset_id}", status_code=204)
async def delete_asset_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    await delete_asset(session, user_id=user.id, asset_id=asset_id)


@router.post("/{asset_id}/generate-outline", response_model=AssetRead)
async def generate_outline_route(
    asset_id: str,
    body: GenerateOutlineRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    if body.regenerate or not (asset.outline or "").strip():
        asset = await update_asset(session, user_id=user.id, asset_id=asset_id, body=AssetUpdate(outline=await generate_outline(session, asset=asset)))
    return asset


@router.post("/{asset_id}/generate-draft", response_model=AssetRead)
async def generate_draft_route(
    asset_id: str,
    body: GenerateDraftRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    updates = {}
    if body.regenerate or not (asset.outline or "").strip():
        updates["outline"] = await generate_outline(session, asset=asset)
        asset.outline = updates["outline"]
    if body.regenerate or not (asset.draft_content or "").strip():
        updates["draft_content"] = await generate_draft(session, asset=asset)
    asset = await update_asset(session, user_id=user.id, asset_id=asset_id, body=AssetUpdate(**updates))
    return asset


@router.post("/{asset_id}/attach-references", response_model=AssetRead)
async def attach_references_route(
    asset_id: str,
    body: AttachReferencesRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    reference_notes = await attach_references(session, asset=asset)
    if not body.include_reference_notes:
        reference_notes = "- References attached but hidden from notes"
    return await update_asset(session, user_id=user.id, asset_id=asset_id, body=AssetUpdate(reference_notes=reference_notes))


@router.post("/{asset_id}/check-readiness", response_model=ReadinessCheckResult)
async def check_readiness_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    ready, blocking_reasons, warning_reasons, suggestion_reasons = check_readiness(asset)
    return ReadinessCheckResult(
        ready=ready,
        blocking_reasons=blocking_reasons,
        warning_reasons=warning_reasons,
        suggestion_reasons=suggestion_reasons,
    )


@router.post("/{asset_id}/export/markdown", response_model=AssetExportResult)
async def export_markdown_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    ready, blocking_reasons, _, _ = check_readiness(asset)
    if not ready:
        raise HTTPException(status_code=409, detail="Asset is not ready to export: " + "; ".join(blocking_reasons))
    if not (asset.reference_notes or "").strip():
        raise HTTPException(status_code=409, detail="Asset export requires a references section. Attach references first.")
    content = export_markdown(asset)
    await update_asset(
        session,
        user_id=user.id,
        asset_id=asset_id,
        body=AssetUpdate(status="exported", export_format="markdown"),
    )
    return AssetExportResult(asset_id=asset_id, export_format="markdown", content=content)


@router.post("/{asset_id}/publish-feedback", response_model=AssetRead)
async def update_publish_feedback_route(
    asset_id: str,
    body: AssetPublishFeedbackUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    if body.published_at and asset.asset_type == "research_brief":
        ready, blocking_reasons, _, _ = check_readiness(asset)
        if not ready:
            raise HTTPException(
                status_code=409,
                detail="Asset is not ready to publish: " + "; ".join(blocking_reasons),
            )
    metadata = dict(asset.metadata_ or {})
    metadata["publish_feedback"] = {
        "publish_url": body.publish_url,
        "channel": body.channel,
        "published_at": body.published_at.isoformat() if body.published_at else None,
        "feedback": body.feedback,
    }
    status = "published" if body.published_at else asset.status
    return await update_asset(
        session,
        user_id=user.id,
        asset_id=asset_id,
        body=AssetUpdate(status=status, metadata=metadata),
    )


@router.post("/{asset_id}/feedback-to-note", response_model=AssetFeedbackNoteResult)
async def convert_asset_feedback_to_note_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    content_parts = []
    if asset.editor_feedback:
        content_parts.extend(["## Editor Feedback", asset.editor_feedback])
    publish_feedback = dict((asset.metadata_ or {}).get("publish_feedback") or {})
    if publish_feedback.get("feedback"):
        content_parts.extend(["", "## Publish Feedback", str(publish_feedback.get("feedback"))])
    if not content_parts:
        raise HTTPException(status_code=400, detail="No feedback available to convert into a note")

    note = await persist_note(
        session=session,
        body=NoteCreate(
            title=f"Asset Feedback - {asset.title}",
            note_type="inbox",
            category_id=1,
            tags=["asset-feedback", asset.asset_type],
            content="\n".join(content_parts),
            source_ids=asset.source_refs or [],
        ),
        user_id=user.id,
        file_path=None,
        content_override="\n".join(content_parts),
    )
    return AssetFeedbackNoteResult(asset_id=asset.id, note_id=note.id)
