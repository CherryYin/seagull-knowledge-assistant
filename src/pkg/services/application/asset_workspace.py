from copy import deepcopy
from datetime import datetime, timezone
import logging
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note, NoteEmbedding
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiEmbedding, WikiPage
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
from pkg.services.application.assets import get_asset
from pkg.services.cross_cutting.embedding import get_embedding_service

WORKSPACE_METADATA_KEY = "asset_workspace_v1"
logger = logging.getLogger(__name__)


def audit_asset_workspace(asset: Asset, workspace: dict):
    from pkg.schemas.application.asset import AssetQualityAuditResult, AssetQualityFinding

    blocking: list[AssetQualityFinding] = []
    warnings: list[AssetQualityFinding] = []
    intent = workspace.get("intent")
    evidence = {item.get("id"): item for item in workspace.get("evidence", []) if item.get("id")}
    claims = {item.get("id"): item for item in workspace.get("claims", []) if item.get("id")}
    candidates = [item for item in workspace.get("knowledge_candidates", []) if item.get("status") not in {"rejected", "promoted"}]

    def block(identifier: str, title: str, detail: str):
        blocking.append(AssetQualityFinding(id=identifier, severity="P0", title=title, detail=detail))

    def warn(identifier: str, title: str, detail: str):
        warnings.append(AssetQualityFinding(id=identifier, severity="P1", title=title, detail=detail))

    if not intent:
        block("PKG-INTENT-001", "Confirmed intent is missing", "Define and confirm the asset question, goal, and audience before promotion.")
    if not candidates and not (asset.draft_content or "").strip():
        block("PKG-CONTENT-001", "Generated content is missing", "Create a Knowledge Candidate or add draft content before quality review.")
    if not candidates and (asset.draft_content or "").strip():
        warn("PKG-CANDIDATE-001", "Draft is not linked to a Knowledge Candidate", "Create a candidate so claims, evidence, and promotion decisions remain traceable.")

    for candidate in candidates:
        candidate_id = candidate.get("id", "unknown")
        if not (candidate.get("content") or "").strip():
            block("PKG-CONTENT-002", "Candidate content is empty", f"Candidate {candidate_id} has no content.")
        for claim_id in candidate.get("claim_refs", []):
            claim = claims.get(claim_id)
            if not claim:
                block("PKG-CLAIM-001", "Candidate references a missing claim", f"Candidate {candidate_id} references {claim_id}.")
                continue
            if claim.get("status") not in {"accepted", "hypothesis"}:
                block("PKG-CLAIM-002", "Candidate claim is not accepted", f"Claim {claim_id} has status {claim.get('status', 'unknown')}.")
            supporting = claim.get("supporting_evidence", [])
            if not supporting:
                block("PKG-EVIDENCE-001", "Claim has no supporting evidence", f"Claim {claim_id} must reference supporting evidence.")
            for evidence_id in supporting:
                evidence_item = evidence.get(evidence_id)
                if not evidence_item:
                    block("PKG-EVIDENCE-002", "Claim references missing evidence", f"Claim {claim_id} references {evidence_id}.")
                elif evidence_item.get("status") != "accepted":
                    block("PKG-EVIDENCE-003", "Claim relies on unaccepted evidence", f"Evidence {evidence_id} has status {evidence_item.get('status', 'unknown')}.")
            contradictions = [item for item in claim.get("contradicting_evidence", []) if evidence.get(item, {}).get("status") == "accepted"]
            if contradictions:
                block("PKG-EVIDENCE-004", "Claim has unresolved contradicting evidence", f"Claim {claim_id} is contradicted by {', '.join(contradictions)}.")

    blocker_count = len(blocking)
    warning_count = len(warnings)
    score = max(0.0, round(5.0 - blocker_count * 1.5 - warning_count * 0.25, 1))
    verdict = "block" if blocking else ("warn" if warnings else "pass")
    return AssetQualityAuditResult(
        asset_id=asset.id,
        workspace_revision=workspace.get("workspace_revision", 0),
        verdict=verdict,
        score=score,
        blocking_findings=blocking,
        warnings=warnings,
        metrics={
            "intent": 1.0 if intent else 0.0,
            "candidate_count": float(len(candidates)),
            "claim_count": float(len(claims)),
            "evidence_count": float(len(evidence)),
        },
    )


def _empty_workspace() -> dict:
    return {
        "workspace_revision": 0,
        "intent": None,
        "intent_history": [],
        "evidence": [],
        "claims": [],
        "contribution": None,
        "knowledge_candidates": [],
        "decision_items": [],
    }


def _workspace_from_metadata(metadata: dict | None) -> dict:
    workspace = _empty_workspace()
    stored = (metadata or {}).get(WORKSPACE_METADATA_KEY)
    if isinstance(stored, dict):
        workspace.update(deepcopy(stored))
    return workspace


def _workspace_read(asset_id: str, workspace: dict) -> AssetWorkspaceRead:
    return AssetWorkspaceRead(asset_id=asset_id, **workspace)


async def _get_asset_for_update(session: AsyncSession, *, user_id: str, asset_id: str) -> Asset:
    row = await session.execute(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user_id).with_for_update()
    )
    asset = row.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _validate_workspace_revision(workspace: dict, expected_revision: int) -> None:
    current_revision = workspace["workspace_revision"]
    if expected_revision != current_revision:
        raise HTTPException(
            status_code=409,
            detail=f"Asset workspace revision changed: expected {expected_revision}, current {current_revision}",
        )


async def _validate_evidence_targets(
    session: AsyncSession,
    *,
    user_id: str,
    proposals: list,
) -> None:
    model_by_type = {"source": Source, "note": Note, "wiki": WikiPage}
    for target_type, model in model_by_type.items():
        target_ids = {item.target_id for item in proposals if item.target_type == target_type}
        if not target_ids:
            continue
        rows = await session.execute(select(model.id).where(model.user_id == user_id, model.id.in_(target_ids)))
        found = set(rows.scalars())
        missing = sorted(target_ids - found)
        if missing:
            raise HTTPException(status_code=404, detail=f"Unknown {target_type} evidence: {', '.join(missing)}")


async def _save_workspace(session: AsyncSession, *, asset: Asset, metadata: dict, workspace: dict) -> AssetWorkspaceRead:
    metadata[WORKSPACE_METADATA_KEY] = workspace
    asset.metadata_ = metadata
    await session.commit()
    await session.refresh(asset)
    return _workspace_read(asset.id, workspace)


async def get_asset_workspace(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
) -> AssetWorkspaceRead:
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id)
    return _workspace_read(asset.id, _workspace_from_metadata(asset.metadata_))


async def revise_asset_intent(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    body: AssetIntentRevisionRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    current_workspace_revision = workspace["workspace_revision"]
    _validate_workspace_revision(workspace, body.base_workspace_revision)

    current_intent = workspace.get("intent")
    history = list(workspace.get("intent_history") or [])
    if isinstance(current_intent, dict):
        history.append(deepcopy(current_intent))

    next_workspace_revision = current_workspace_revision + 1
    next_intent_revision = int(current_intent.get("revision", 0)) + 1 if isinstance(current_intent, dict) else 1
    intent = {
        "revision": next_intent_revision,
        "question": body.question.strip(),
        "goal": body.goal.strip(),
        "audience": body.audience.strip() if body.audience else None,
        "creation_mode": body.creation_mode.strip(),
        "scope": body.scope,
        "constraints": body.constraints,
        "status": "confirmed",
        "confirmed_by": user_id,
        "confirmed_at": datetime.now(timezone.utc).isoformat(),
    }
    workspace.update(
        {
            "workspace_revision": next_workspace_revision,
            "intent": intent,
            "intent_history": history,
        }
    )
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


async def propose_asset_evidence(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    body: AssetEvidenceProposalBatchRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    intent = workspace.get("intent")
    if not isinstance(intent, dict):
        raise HTTPException(status_code=409, detail="Confirm Asset Intent before proposing evidence")
    await _validate_evidence_targets(session, user_id=user_id, proposals=body.proposals)

    created_at = datetime.now(timezone.utc).isoformat()
    evidence = list(workspace.get("evidence") or [])
    for proposal in body.proposals:
        evidence.append(
            {
                "id": f"evidence-{uuid.uuid4().hex[:12]}",
                **proposal.model_dump(mode="json"),
                "status": "proposed",
                "authorship": "agent",
                "intent_revision": intent["revision"],
                "source_session_id": body.session_id,
                "created_at": created_at,
                "decided_by": None,
                "decided_at": None,
            }
        )
    workspace["evidence"] = evidence
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


async def decide_asset_evidence(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    evidence_id: str,
    body: AssetEvidenceDecisionRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    evidence = list(workspace.get("evidence") or [])
    selected = next((item for item in evidence if item.get("id") == evidence_id), None)
    if selected is None:
        raise HTTPException(status_code=404, detail="Asset evidence not found")

    selected["status"] = body.decision
    selected["decided_by"] = user_id
    selected["decided_at"] = datetime.now(timezone.utc).isoformat()
    if body.decision == "accepted":
        ref_field = {"source": "source_refs", "note": "note_refs", "wiki": "wiki_refs"}.get(selected["target_type"])
        if ref_field:
            refs = list(getattr(asset, ref_field) or [])
            if selected["target_id"] not in refs:
                refs.append(selected["target_id"])
                setattr(asset, ref_field, refs)
    workspace["evidence"] = evidence
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


def _validate_claim_evidence_refs(workspace: dict, proposals: list) -> None:
    evidence = {item.get("id"): item for item in workspace.get("evidence") or []}
    referenced = {
        evidence_id
        for proposal in proposals
        for evidence_id in [*proposal.supporting_evidence, *proposal.contradicting_evidence]
    }
    unknown = sorted(evidence_id for evidence_id in referenced if evidence_id not in evidence)
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown Asset evidence refs: {', '.join(unknown)}")
    rejected = sorted(evidence_id for evidence_id in referenced if evidence[evidence_id].get("status") == "rejected")
    if rejected:
        raise HTTPException(status_code=422, detail=f"Rejected evidence cannot support a Claim: {', '.join(rejected)}")


async def propose_asset_claims(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    body: AssetClaimProposalBatchRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    intent = workspace.get("intent")
    if not isinstance(intent, dict):
        raise HTTPException(status_code=409, detail="Confirm Asset Intent before proposing Claims")
    _validate_claim_evidence_refs(workspace, body.proposals)

    created_at = datetime.now(timezone.utc).isoformat()
    claims = list(workspace.get("claims") or [])
    for proposal in body.proposals:
        claims.append(
            {
                "id": f"claim-{uuid.uuid4().hex[:12]}",
                **proposal.model_dump(mode="json"),
                "status": "proposed",
                "authorship": "agent",
                "intent_revision": intent["revision"],
                "source_session_id": body.session_id,
                "created_at": created_at,
                "decided_by": None,
                "decided_at": None,
                "user_edited": False,
            }
        )
    workspace["claims"] = claims
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


def _ensure_claim_is_acceptable(workspace: dict, claim: dict) -> None:
    supporting = claim.get("supporting_evidence") or []
    if not supporting:
        raise HTTPException(status_code=409, detail="Accepting an Agent Claim requires supporting Evidence")
    evidence = {item.get("id"): item for item in workspace.get("evidence") or []}
    referenced = [*supporting, *(claim.get("contradicting_evidence") or [])]
    unresolved = sorted(evidence_id for evidence_id in referenced if evidence.get(evidence_id, {}).get("status") != "accepted")
    if unresolved:
        raise HTTPException(status_code=409, detail=f"Resolve referenced Evidence before accepting Claim: {', '.join(unresolved)}")


async def decide_asset_claim(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    claim_id: str,
    body: AssetClaimDecisionRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    claims = list(workspace.get("claims") or [])
    claim = next((item for item in claims if item.get("id") == claim_id), None)
    if claim is None:
        raise HTTPException(status_code=404, detail="Asset Claim not found")

    if body.decision in {"accept", "edit_and_accept"}:
        _ensure_claim_is_acceptable(workspace, claim)
        claim["status"] = "accepted"
        if body.decision == "edit_and_accept":
            claim["content"] = body.edited_content
            claim["user_edited"] = True
    elif body.decision == "reject":
        claim["status"] = "rejected"
    elif body.decision == "keep_as_hypothesis":
        claim["status"] = "hypothesis"
    else:
        claim["status"] = "needs_more_evidence"
    claim["decided_by"] = user_id
    claim["decided_at"] = datetime.now(timezone.utc).isoformat()
    workspace["claims"] = claims
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


def _validate_knowledge_claim_refs(workspace: dict, claim_refs: set[str]) -> None:
    claims = {item.get("id"): item for item in workspace.get("claims") or []}
    unknown = sorted(claim_id for claim_id in claim_refs if claim_id not in claims)
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown Asset Claim refs: {', '.join(unknown)}")
    unavailable = sorted(
        claim_id
        for claim_id in claim_refs
        if claims[claim_id].get("status") not in {"accepted", "hypothesis"}
    )
    if unavailable:
        raise HTTPException(
            status_code=409,
            detail=f"Contribution and Knowledge Candidates require accepted Claims or retained Hypotheses: {', '.join(unavailable)}",
        )


async def _validate_knowledge_candidate_targets(
    session: AsyncSession,
    *,
    user_id: str,
    body: AssetKnowledgeProposalRequest,
) -> None:
    target_ids = {
        item.target_wiki_id
        for item in body.candidates
        if item.candidate_type == "wiki" and item.action == "update" and item.target_wiki_id
    }
    if not target_ids:
        return
    rows = await session.execute(
        select(WikiPage.id).where(WikiPage.user_id == user_id, WikiPage.id.in_(target_ids))
    )
    found = set(rows.scalars().all())
    missing = sorted(target_ids - found)
    if missing:
        raise HTTPException(status_code=404, detail=f"Wiki target not found: {', '.join(missing)}")


async def propose_asset_knowledge(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    body: AssetKnowledgeProposalRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    current_contribution = workspace.get("contribution")
    if isinstance(current_contribution, dict) and current_contribution.get("status") != "rejected":
        raise HTTPException(status_code=409, detail="Resolve the current Asset Contribution before proposing another")

    claim_refs = set(body.contribution.claim_refs)
    for candidate in body.candidates:
        claim_refs.update(candidate.claim_refs)
    _validate_knowledge_claim_refs(workspace, claim_refs)
    await _validate_knowledge_candidate_targets(session, user_id=user_id, body=body)

    created_at = datetime.now(timezone.utc).isoformat()
    workspace["contribution"] = {
        "id": f"contribution-{uuid.uuid4().hex[:12]}",
        **body.contribution.model_dump(mode="json"),
        "status": "proposed",
        "authorship": "agent",
        "attribution": None,
        "source_session_id": body.session_id,
        "created_at": created_at,
        "decided_by": None,
        "decided_at": None,
        "user_edited": False,
    }
    candidates = list(workspace.get("knowledge_candidates") or [])
    for proposal in body.candidates:
        candidates.append({
            "id": f"knowledge-{uuid.uuid4().hex[:12]}",
            **proposal.model_dump(mode="json"),
            "status": "proposed",
            "authorship": "agent",
            "source_session_id": body.session_id,
            "created_at": created_at,
            "decided_by": None,
            "decided_at": None,
            "promoted_at": None,
        })
    workspace["knowledge_candidates"] = candidates
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


async def decide_asset_contribution(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    body: AssetContributionDecisionRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    contribution = workspace.get("contribution")
    if not isinstance(contribution, dict):
        raise HTTPException(status_code=404, detail="Asset Contribution not found")
    if contribution.get("status") != "proposed":
        raise HTTPException(status_code=409, detail="Asset Contribution has already been decided")

    if body.decision in {"accept", "edit_and_accept"}:
        contribution["status"] = "accepted"
        contribution["attribution"] = body.attribution
        if body.decision == "edit_and_accept":
            contribution["summary"] = body.edited_summary
            contribution["user_edited"] = True
    else:
        contribution["status"] = "rejected"
        contribution["attribution"] = None
    contribution["decided_by"] = user_id
    contribution["decided_at"] = datetime.now(timezone.utc).isoformat()
    workspace["contribution"] = contribution
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


async def decide_asset_knowledge_candidate(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    candidate_id: str,
    body: AssetKnowledgeCandidateDecisionRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    candidates = list(workspace.get("knowledge_candidates") or [])
    candidate = next((item for item in candidates if item.get("id") == candidate_id), None)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Knowledge Candidate not found")
    if candidate.get("status") != "proposed":
        raise HTTPException(status_code=409, detail="Knowledge Candidate has already been decided")

    candidate["status"] = "kept" if body.decision == "keep" else "rejected"
    candidate["decided_by"] = user_id
    candidate["decided_at"] = datetime.now(timezone.utc).isoformat()
    candidate["promoted_at"] = None
    workspace["knowledge_candidates"] = candidates
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)


def _promotion_reference_ids(workspace: dict, claim_refs: list[str]) -> tuple[list[str], list[str]]:
    claims = {item.get("id"): item for item in workspace.get("claims") or []}
    evidence = {item.get("id"): item for item in workspace.get("evidence") or []}
    evidence_ids = {
        evidence_id
        for claim_id in claim_refs
        for evidence_id in [
            *(claims.get(claim_id, {}).get("supporting_evidence") or []),
            *(claims.get(claim_id, {}).get("contradicting_evidence") or []),
        ]
    }
    source_ids = sorted({
        item["target_id"]
        for evidence_id in evidence_ids
        if (item := evidence.get(evidence_id))
        and item.get("status") == "accepted"
        and item.get("target_type") == "source"
    })
    note_ids = sorted({
        item["target_id"]
        for evidence_id in evidence_ids
        if (item := evidence.get(evidence_id))
        and item.get("status") == "accepted"
        and item.get("target_type") == "note"
    })
    return source_ids, note_ids


async def _add_promotion_embeddings(session: AsyncSession, *, target_type: str, target: Note | WikiPage) -> None:
    try:
        embedding_service = get_embedding_service()
        if target_type == "note":
            session.add(NoteEmbedding(
                note_id=target.id,
                title_vec=await embedding_service.embed_text(target.title),
                abstract_vec=await embedding_service.embed_text(target.abstract or target.title),
            ))
            return
        title_vec = await embedding_service.embed_text(target.title)
        summary_vec = await embedding_service.embed_text(target.summary or target.title)
        content_vec = await embedding_service.embed_text(target.content or target.summary or target.title)
        embedding = await session.get(WikiEmbedding, target.id)
        if embedding:
            embedding.title_vec = title_vec
            embedding.summary_vec = summary_vec
            embedding.content_vec = content_vec
        else:
            session.add(WikiEmbedding(
                wiki_id=target.id,
                title_vec=title_vec,
                summary_vec=summary_vec,
                content_vec=content_vec,
            ))
    except Exception:
        logger.error("Embedding generation failed for promoted %s %s", target_type, target.id, exc_info=True)


async def promote_asset_knowledge_candidate(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
    candidate_id: str,
    body: AssetKnowledgePromotionRequest,
) -> AssetWorkspaceRead:
    asset = await _get_asset_for_update(session, user_id=user_id, asset_id=asset_id)
    metadata = deepcopy(asset.metadata_ or {})
    workspace = _workspace_from_metadata(metadata)
    _validate_workspace_revision(workspace, body.base_workspace_revision)
    contribution = workspace.get("contribution")
    if not isinstance(contribution, dict) or contribution.get("status") != "accepted":
        raise HTTPException(status_code=409, detail="Accept the Asset Contribution before promoting Knowledge")

    candidates = list(workspace.get("knowledge_candidates") or [])
    candidate = next((item for item in candidates if item.get("id") == candidate_id), None)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Knowledge Candidate not found")
    if candidate.get("status") != "kept":
        raise HTTPException(status_code=409, detail="Keep the Knowledge Candidate before promotion")
    _validate_knowledge_claim_refs(workspace, set(candidate.get("claim_refs") or []))

    title = body.edited_title or candidate["title"]
    content = body.edited_content or candidate["content"]
    user_edited = title != candidate["title"] or content != candidate["content"]
    source_ids, note_ids = _promotion_reference_ids(workspace, candidate.get("claim_refs") or [])
    attribution_tag = "user-insight" if contribution.get("attribution") == "user_insight" else "from-agent"

    if candidate["candidate_type"] == "note":
        target_id = f"note-{candidate_id}"
        target = Note(
            id=target_id,
            user_id=user_id,
            category_id=1,
            title=title,
            note_type="concept",
            domains=[],
            tags=["asset-promotion", attribution_tag],
            abstract=contribution.get("summary"),
            content=content,
            project=None,
            status="seed",
            confidence="medium",
            source_ids=source_ids,
            file_path=None,
            word_count=len(content.split()),
        )
        session.add(target)
        refs = list(asset.note_refs or [])
        if target_id not in refs:
            asset.note_refs = [*refs, target_id]
        target_type = "note"
    elif candidate["action"] == "create":
        target_id = f"wiki-{candidate_id}"
        target = WikiPage(
            id=target_id,
            user_id=user_id,
            title=title,
            page_type="topic",
            summary=contribution.get("summary"),
            content=content,
            domains=[],
            tags=["wiki-draft", "asset-promotion", attribution_tag],
            derived_from_notes=note_ids,
            derived_from_sources=source_ids,
            open_questions=[],
            confidence_score=None,
            last_compiled_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        session.add(target)
        refs = list(asset.wiki_refs or [])
        if target_id not in refs:
            asset.wiki_refs = [*refs, target_id]
        target_type = "wiki"
    else:
        if not body.confirm_overwrite:
            raise HTTPException(status_code=409, detail="Wiki update promotion requires explicit overwrite confirmation")
        target_id = candidate.get("target_wiki_id")
        row = await session.execute(
            select(WikiPage).where(WikiPage.id == target_id, WikiPage.user_id == user_id).with_for_update()
        )
        target = row.scalar_one_or_none()
        if target is None:
            raise HTTPException(status_code=404, detail="Wiki target not found")
        tags = list(target.tags or [])
        if "wiki-draft" not in tags and "edited-stable" not in tags:
            tags.append("edited-stable")
        if "asset-promotion" not in tags:
            tags.append("asset-promotion")
        target.title = title
        target.summary = contribution.get("summary")
        target.content = content
        target.tags = tags
        target.derived_from_notes = list(dict.fromkeys([*(target.derived_from_notes or []), *note_ids]))
        target.derived_from_sources = list(dict.fromkeys([*(target.derived_from_sources or []), *source_ids]))
        target.last_compiled_at = datetime.now(timezone.utc).replace(tzinfo=None)
        refs = list(asset.wiki_refs or [])
        if target_id not in refs:
            asset.wiki_refs = [*refs, target_id]
        target_type = "wiki"

    await _add_promotion_embeddings(session, target_type=target_type, target=target)

    promoted_at = datetime.now(timezone.utc).isoformat()
    candidate.update({
        "title": title,
        "content": content,
        "status": "promoted",
        "promoted_at": promoted_at,
        "promoted_by": user_id,
        "promoted_target_type": target_type,
        "promoted_target_id": target_id,
        "user_edited": user_edited,
    })
    workspace["knowledge_candidates"] = candidates
    workspace["workspace_revision"] += 1
    return await _save_workspace(session, asset=asset, metadata=metadata, workspace=workspace)
