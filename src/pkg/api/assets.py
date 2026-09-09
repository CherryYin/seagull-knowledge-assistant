from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.application.asset import (
    AssetCreate,
    AssetExportResult,
    AssetQualityAuditResult,
    AssetFeedbackNoteResult,
    AssetKnowledgeLineageList,
    AssetList,
    AssetPublishFeedbackUpdate,
    AssetRead,
    AssetUpdate,
    AttachReferencesRequest,
    NewsletterAutomationConfig,
    NewsletterAutomationRunResult,
    NewsletterAutomationUpdate,
    ReadinessCheckResult,
)
from pkg.schemas.application.asset_workspace import (
    AssetClaimDecisionRequest,
    AssetClaimProposalBatchRequest,
    AssetContributionDecisionRequest,
    AssetEvidenceDecisionRequest,
    AssetEvidenceProposalBatchRequest,
    AssetIntentRevisionRequest,
    AssetKnowledgeCandidateDecisionRequest,
    AssetKnowledgePromotionRequest,
    AssetKnowledgeProposalRequest,
    AssetWorkspaceRead,
)
from pkg.schemas.note import NoteCreate
from pkg.services.application.assets import create_asset, delete_asset, get_asset, list_asset_knowledge_lineage, list_assets, update_asset
from pkg.services.application.asset_workspace import (
    decide_asset_claim,
    decide_asset_contribution,
    decide_asset_evidence,
    decide_asset_knowledge_candidate,
    get_asset_workspace,
    audit_asset_workspace,
    promote_asset_knowledge_candidate,
    propose_asset_evidence,
    propose_asset_knowledge,
    propose_asset_claims,
    revise_asset_intent,
)
from pkg.services.application.blog_generation import (
    attach_references,
    check_readiness,
    export_html,
    export_markdown,
)
from pkg.services.application.newsletter_automation import (
    generate_newsletter,
    get_newsletter_config,
    update_newsletter_config,
)
from pkg.api.notes import persist_note

router = APIRouter()


@router.post("", response_model=AssetRead)
async def create_asset_route(
    body: AssetCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await create_asset(session, user_id=user.id, body=body)


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


@router.get("/newsletter/automation", response_model=NewsletterAutomationConfig)
async def get_newsletter_automation_route(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await get_newsletter_config(session, user_id=user.id)


@router.put("/newsletter/automation", response_model=NewsletterAutomationConfig)
async def update_newsletter_automation_route(
    body: NewsletterAutomationUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await update_newsletter_config(session, user_id=user.id, body=body)


@router.post("/newsletter/automation/run", response_model=NewsletterAutomationRunResult)
async def run_newsletter_automation_route(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await generate_newsletter(session, user_id=user.id, force=True)


@router.get("/knowledge-lineage", response_model=AssetKnowledgeLineageList)
async def get_asset_knowledge_lineage_route(
    target_type: Literal["note", "wiki"],
    target_id: str = Query(min_length=1),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await list_asset_knowledge_lineage(
        session,
        user_id=user.id,
        target_type=target_type,
        target_id=target_id,
    )


@router.get("/{asset_id}", response_model=AssetRead)
async def get_asset_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await get_asset(session, user_id=user.id, asset_id=asset_id)


@router.get("/{asset_id}/workspace", response_model=AssetWorkspaceRead)
async def get_asset_workspace_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await get_asset_workspace(session, user_id=user.id, asset_id=asset_id)


@router.get("/{asset_id}/quality-audit", response_model=AssetQualityAuditResult)
async def audit_asset_quality_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    workspace = await get_asset_workspace(session, user_id=user.id, asset_id=asset_id)
    return audit_asset_workspace(asset, workspace.model_dump(mode="json"))


@router.post("/{asset_id}/workspace/intent", response_model=AssetWorkspaceRead)
async def revise_asset_intent_route(
    asset_id: str,
    body: AssetIntentRevisionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await revise_asset_intent(session, user_id=user.id, asset_id=asset_id, body=body)


@router.post("/{asset_id}/workspace/evidence/proposals", response_model=AssetWorkspaceRead)
async def propose_asset_evidence_route(
    asset_id: str,
    body: AssetEvidenceProposalBatchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await propose_asset_evidence(session, user_id=user.id, asset_id=asset_id, body=body)


@router.post("/{asset_id}/workspace/evidence/{evidence_id}/decision", response_model=AssetWorkspaceRead)
async def decide_asset_evidence_route(
    asset_id: str,
    evidence_id: str,
    body: AssetEvidenceDecisionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await decide_asset_evidence(
        session,
        user_id=user.id,
        asset_id=asset_id,
        evidence_id=evidence_id,
        body=body,
    )


@router.post("/{asset_id}/workspace/claims/proposals", response_model=AssetWorkspaceRead)
async def propose_asset_claims_route(
    asset_id: str,
    body: AssetClaimProposalBatchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await propose_asset_claims(session, user_id=user.id, asset_id=asset_id, body=body)


@router.post("/{asset_id}/workspace/claims/{claim_id}/decision", response_model=AssetWorkspaceRead)
async def decide_asset_claim_route(
    asset_id: str,
    claim_id: str,
    body: AssetClaimDecisionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await decide_asset_claim(
        session,
        user_id=user.id,
        asset_id=asset_id,
        claim_id=claim_id,
        body=body,
    )


@router.post("/{asset_id}/workspace/knowledge/proposals", response_model=AssetWorkspaceRead)
async def propose_asset_knowledge_route(
    asset_id: str,
    body: AssetKnowledgeProposalRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await propose_asset_knowledge(session, user_id=user.id, asset_id=asset_id, body=body)


@router.post("/{asset_id}/workspace/contribution/decision", response_model=AssetWorkspaceRead)
async def decide_asset_contribution_route(
    asset_id: str,
    body: AssetContributionDecisionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await decide_asset_contribution(session, user_id=user.id, asset_id=asset_id, body=body)


@router.post("/{asset_id}/workspace/knowledge/{candidate_id}/decision", response_model=AssetWorkspaceRead)
async def decide_asset_knowledge_candidate_route(
    asset_id: str,
    candidate_id: str,
    body: AssetKnowledgeCandidateDecisionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await decide_asset_knowledge_candidate(
        session,
        user_id=user.id,
        asset_id=asset_id,
        candidate_id=candidate_id,
        body=body,
    )


@router.post("/{asset_id}/workspace/knowledge/{candidate_id}/promote", response_model=AssetWorkspaceRead)
async def promote_asset_knowledge_candidate_route(
    asset_id: str,
    candidate_id: str,
    body: AssetKnowledgePromotionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await promote_asset_knowledge_candidate(
        session,
        user_id=user.id,
        asset_id=asset_id,
        candidate_id=candidate_id,
        body=body,
    )


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


@router.get("/{asset_id}/preview/html", response_model=AssetExportResult)
async def preview_html_route(
    asset_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    asset = await get_asset(session, user_id=user.id, asset_id=asset_id)
    return AssetExportResult(asset_id=asset_id, export_format="html", content=export_html(asset))


@router.post("/{asset_id}/export/html", response_model=AssetExportResult)
async def export_html_route(
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
    content = export_html(asset)
    await update_asset(
        session,
        user_id=user.id,
        asset_id=asset_id,
        body=AssetUpdate(status="exported", export_format="html"),
    )
    return AssetExportResult(asset_id=asset_id, export_format="html", content=content)


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
