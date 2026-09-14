from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.models.application.asset import Asset


def _make_asset(*, metadata: dict | None = None) -> Asset:
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="research_brief",
        status="draft",
        title="Agent database access",
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        metadata_=metadata,
    )
    asset.created_at = datetime(2026, 8, 28, tzinfo=timezone.utc)
    asset.updated_at = datetime(2026, 8, 28, tzinfo=timezone.utc)
    return asset


def _intent_request(*, base_workspace_revision: int = 0, question: str = "Should agents access PostgreSQL?"):
    from pkg.schemas.application.asset_workspace import AssetIntentRevisionRequest

    return AssetIntentRevisionRequest(
        base_workspace_revision=base_workspace_revision,
        question=question,
        goal="Define a safe capability model",
        audience="System designers",
        creation_mode="make_decision",
        scope=["PostgreSQL", "Harness"],
        constraints=["Do not expose credentials"],
    )


def _workspace_metadata(*, revision: int = 1, evidence: list[dict] | None = None, claims: list[dict] | None = None):
    return {
        "asset_workspace_v1": {
            "workspace_revision": revision,
            "intent": {
                "revision": 1,
                "question": "Should agents access PostgreSQL?",
                "goal": "Define a safe capability model",
                "audience": "System designers",
                "creation_mode": "make_decision",
                "scope": ["PostgreSQL", "Harness"],
                "constraints": ["Do not expose credentials"],
                "status": "confirmed",
                "confirmed_by": "user-1",
                "confirmed_at": "2026-08-28T08:00:00+00:00",
            },
            "intent_history": [],
            "evidence": evidence or [],
            "claims": claims or [],
            "contribution": None,
            "knowledge_candidates": [],
            "decision_items": [],
        }
    }


@pytest.mark.asyncio
async def test_get_asset_workspace_returns_empty_workspace_when_uninitialized():
    from pkg.services.application.asset_workspace import get_asset_workspace

    session = AsyncMock()
    asset = _make_asset(metadata={"existing": {"keep": True}})

    with patch("pkg.services.application.asset_workspace.get_asset", new=AsyncMock(return_value=asset)):
        workspace = await get_asset_workspace(session, user_id="user-1", asset_id="asset-1")

    assert workspace.asset_id == "asset-1"
    assert workspace.workspace_revision == 0
    assert workspace.intent is None
    assert workspace.intent_history == []


@pytest.mark.asyncio
async def test_revise_asset_intent_initializes_revision_and_preserves_metadata():
    from pkg.services.application.asset_workspace import revise_asset_intent

    session = AsyncMock()
    asset = _make_asset(metadata={"existing": {"keep": True}})

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await revise_asset_intent(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=_intent_request(),
        )

    assert workspace.workspace_revision == 1
    assert workspace.intent is not None
    assert workspace.intent.revision == 1
    assert workspace.intent.status == "confirmed"
    assert workspace.intent.confirmed_by == "user-1"
    assert asset.metadata_["existing"] == {"keep": True}
    assert asset.metadata_["asset_workspace_v1"]["intent"]["confirmed_by"] == "user-1"
    session.commit.assert_awaited_once()
    session.refresh.assert_awaited_once_with(asset)


@pytest.mark.asyncio
async def test_revise_asset_intent_appends_previous_intent_to_history():
    from pkg.services.application.asset_workspace import revise_asset_intent

    session = AsyncMock()
    asset = _make_asset()

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        first = await revise_asset_intent(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=_intent_request(),
        )
        second = await revise_asset_intent(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=_intent_request(base_workspace_revision=first.workspace_revision, question="What database access should agents receive?"),
        )

    assert second.workspace_revision == 2
    assert second.intent is not None
    assert second.intent.revision == 2
    assert second.intent.question == "What database access should agents receive?"
    assert [item.revision for item in second.intent_history] == [1]
    assert second.intent_history[0].question == "Should agents access PostgreSQL?"


@pytest.mark.asyncio
async def test_revise_asset_intent_invalidates_downstream_decisions():
    from pkg.services.application.asset_workspace import revise_asset_intent

    metadata = _workspace_metadata(
        revision=7,
        evidence=[{
            "id": "evidence-1",
            "target_type": "source",
            "target_id": "source-1",
            "relation": "supports",
            "summary": "Old evidence.",
            "status": "accepted",
            "authorship": "agent",
            "intent_revision": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }],
        claims=[{
            "id": "claim-1",
            "content": "Old claim.",
            "kind": "synthesis",
            "status": "accepted",
            "supporting_evidence": ["evidence-1"],
            "contradicting_evidence": [],
            "agent_confidence": "high",
            "authorship": "agent",
            "intent_revision": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "user_edited": False,
        }],
    )
    metadata["asset_workspace_v1"]["contribution"] = {
        "id": "contribution-1",
        "kind": "synthesis",
        "summary": "Old contribution.",
        "claim_refs": ["claim-1"],
        "status": "accepted",
        "authorship": "agent",
        "attribution": "agent_synthesis",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "user_edited": False,
    }
    metadata["asset_workspace_v1"]["knowledge_candidates"] = [_kept_candidate()]
    session = AsyncMock()
    asset = _make_asset(metadata=metadata)

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await revise_asset_intent(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=_intent_request(base_workspace_revision=7, question="A new question"),
        )

    assert workspace.evidence[0].status == "stale"
    assert workspace.claims[0].status == "superseded"
    assert workspace.contribution.status == "rejected"
    assert workspace.knowledge_candidates[0].status == "rejected"


@pytest.mark.asyncio
async def test_revise_asset_intent_rejects_stale_workspace_revision():
    from pkg.services.application.asset_workspace import revise_asset_intent

    session = AsyncMock()
    asset = _make_asset(
        metadata={
            "asset_workspace_v1": {
                "workspace_revision": 2,
                "intent": None,
                "intent_history": [],
                "evidence": [],
                "claims": [],
                "contribution": None,
                "decision_items": [],
            }
        }
    )

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await revise_asset_intent(
                session,
                user_id="user-1",
                asset_id="asset-1",
                body=_intent_request(base_workspace_revision=1),
            )

    assert exc.value.status_code == 409
    assert "workspace revision" in exc.value.detail.lower()
    session.commit.assert_not_awaited()


def test_intent_revision_request_rejects_blank_question_and_goal():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        _intent_request(question="   ")


@pytest.mark.asyncio
async def test_revise_asset_intent_route_uses_authenticated_user_identity():
    from pkg.api.assets import revise_asset_intent_route

    user = MagicMock(id="user-1")
    session = AsyncMock()
    expected = MagicMock()

    with patch("pkg.api.assets.revise_asset_intent", new=AsyncMock(return_value=expected)) as service:
        result = await revise_asset_intent_route(
            "asset-1",
            _intent_request(),
            user=user,
            session=session,
        )

    assert result is expected
    service.assert_awaited_once_with(session, user_id="user-1", asset_id="asset-1", body=_intent_request())


@pytest.mark.asyncio
async def test_propose_asset_evidence_binds_agent_proposal_to_current_intent():
    from pkg.schemas.application.asset_workspace import AssetEvidenceProposalBatchRequest
    from pkg.services.application.asset_workspace import propose_asset_evidence

    session = AsyncMock()
    asset = _make_asset(metadata={"existing": True, **_workspace_metadata()})
    body = AssetEvidenceProposalBatchRequest(
        base_workspace_revision=1,
        session_id="session-1",
        proposals=[
            {
                "target_type": "source",
                "target_id": "source-1",
                "relation": "supports",
                "summary": "The filesystem sandbox does not govern database credentials.",
                "fragment_selector": {"type": "text_quote", "exact": "Sandbox only governs filesystem effects."},
            }
        ],
    )

    with (
        patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)),
        patch("pkg.services.application.asset_workspace._validate_evidence_targets", new=AsyncMock()),
    ):
        workspace = await propose_asset_evidence(session, user_id="user-1", asset_id="asset-1", body=body)

    assert workspace.workspace_revision == 2
    assert len(workspace.evidence) == 1
    evidence = workspace.evidence[0]
    assert evidence.status == "proposed"
    assert evidence.authorship == "agent"
    assert evidence.intent_revision == 1
    assert evidence.source_session_id == "session-1"
    assert asset.metadata_["existing"] is True
    assert asset.source_refs == []
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_propose_asset_evidence_requires_confirmed_intent():
    from pkg.schemas.application.asset_workspace import AssetEvidenceProposalBatchRequest
    from pkg.services.application.asset_workspace import propose_asset_evidence

    session = AsyncMock()
    asset = _make_asset(metadata={})
    body = AssetEvidenceProposalBatchRequest(
        base_workspace_revision=0,
        proposals=[{"target_type": "note", "target_id": "note-1", "relation": "context", "summary": "Relevant note."}],
    )

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await propose_asset_evidence(session, user_id="user-1", asset_id="asset-1", body=body)

    assert exc.value.status_code == 409
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_decide_asset_evidence_records_user_decision():
    from pkg.schemas.application.asset_workspace import AssetEvidenceDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_evidence

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata(evidence=[{
        "id": "evidence-1",
        "target_type": "source",
        "target_id": "source-1",
        "relation": "supports",
        "summary": "Relevant source.",
        "fragment_selector": None,
        "status": "proposed",
        "authorship": "agent",
        "intent_revision": 1,
        "source_session_id": "session-1",
        "created_at": "2026-08-28T08:00:00+00:00",
        "decided_by": None,
        "decided_at": None,
    }]))

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await decide_asset_evidence(
            session,
            user_id="user-1",
            asset_id="asset-1",
            evidence_id="evidence-1",
            body=AssetEvidenceDecisionRequest(base_workspace_revision=1, decision="accepted"),
        )

    assert workspace.workspace_revision == 2
    assert workspace.evidence[0].status == "accepted"
    assert workspace.evidence[0].decided_by == "user-1"
    assert asset.source_refs == ["source-1"]


@pytest.mark.asyncio
async def test_decide_asset_evidence_rejects_unknown_evidence():
    from pkg.schemas.application.asset_workspace import AssetEvidenceDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_evidence

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata())

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await decide_asset_evidence(
                session,
                user_id="user-1",
                asset_id="asset-1",
                evidence_id="missing",
                body=AssetEvidenceDecisionRequest(base_workspace_revision=1, decision="rejected"),
            )

    assert exc.value.status_code == 404


def test_evidence_proposal_rejects_invalid_web_target():
    from pydantic import ValidationError
    from pkg.schemas.application.asset_workspace import AssetEvidenceProposalInput

    with pytest.raises(ValidationError):
        AssetEvidenceProposalInput(
            target_type="web",
            target_id="not-a-url",
            relation="context",
            summary="Unverified web evidence.",
        )


@pytest.mark.asyncio
async def test_validate_evidence_targets_rejects_unowned_local_reference():
    from pkg.schemas.application.asset_workspace import AssetEvidenceProposalInput
    from pkg.services.application.asset_workspace import _validate_evidence_targets

    session = AsyncMock()
    rows = MagicMock()
    rows.scalars.return_value = []
    session.execute.return_value = rows

    with pytest.raises(HTTPException) as exc:
        await _validate_evidence_targets(
            session,
            user_id="user-1",
            proposals=[AssetEvidenceProposalInput(target_type="source", target_id="source-other", relation="supports", summary="Not owned.")],
        )

    assert exc.value.status_code == 404


def _accepted_evidence(evidence_id: str = "evidence-1") -> dict:
    return {
        "id": evidence_id,
        "target_type": "source",
        "target_id": "source-1",
        "relation": "supports",
        "summary": "The source supports the boundary.",
        "fragment_selector": None,
        "status": "accepted",
        "authorship": "agent",
        "intent_revision": 1,
        "source_session_id": "session-1",
        "created_at": "2026-08-28T08:00:00+00:00",
        "decided_by": "user-1",
        "decided_at": "2026-08-28T08:05:00+00:00",
    }


def _claim(claim_id: str = "claim-1", *, supporting_evidence: list[str] | None = None) -> dict:
    return {
        "id": claim_id,
        "content": "Agents should access databases only through capability-scoped tools.",
        "kind": "recommendation",
        "status": "proposed",
        "supporting_evidence": supporting_evidence or [],
        "contradicting_evidence": [],
        "agent_confidence": "medium",
        "authorship": "agent",
        "intent_revision": 1,
        "source_session_id": "session-1",
        "created_at": "2026-08-28T08:10:00+00:00",
        "decided_by": None,
        "decided_at": None,
        "user_edited": False,
    }


def _accepted_claim(claim_id: str = "claim-1") -> dict:
    claim = _claim(claim_id, supporting_evidence=["evidence-1"])
    claim.update({
        "status": "accepted",
        "decided_by": "user-1",
        "decided_at": "2026-08-28T08:15:00+00:00",
    })
    return claim


@pytest.mark.asyncio
async def test_propose_asset_claims_binds_claims_to_current_intent_and_evidence():
    from pkg.schemas.application.asset_workspace import AssetClaimProposalBatchRequest
    from pkg.services.application.asset_workspace import propose_asset_claims

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata(evidence=[_accepted_evidence()]))
    body = AssetClaimProposalBatchRequest(
        base_workspace_revision=1,
        session_id="session-claim",
        proposals=[{
            "content": "Capability-scoped tools are safer than arbitrary SQL access.",
            "kind": "recommendation",
            "supporting_evidence": ["evidence-1"],
            "contradicting_evidence": [],
            "agent_confidence": "high",
        }],
    )

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await propose_asset_claims(session, user_id="user-1", asset_id="asset-1", body=body)

    assert workspace.workspace_revision == 2
    assert len(workspace.claims) == 1
    claim = workspace.claims[0]
    assert claim.status == "proposed"
    assert claim.authorship == "agent"
    assert claim.intent_revision == 1
    assert claim.supporting_evidence == ["evidence-1"]
    assert claim.source_session_id == "session-claim"


@pytest.mark.asyncio
async def test_propose_asset_claims_rejects_unknown_evidence_reference():
    from pkg.schemas.application.asset_workspace import AssetClaimProposalBatchRequest
    from pkg.services.application.asset_workspace import propose_asset_claims

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata())
    body = AssetClaimProposalBatchRequest(
        base_workspace_revision=1,
        proposals=[{
            "content": "Unsupported conclusion.",
            "kind": "inference",
            "supporting_evidence": ["missing-evidence"],
            "agent_confidence": "low",
        }],
    )

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await propose_asset_claims(session, user_id="user-1", asset_id="asset-1", body=body)

    assert exc.value.status_code == 422
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_accept_claim_requires_accepted_supporting_evidence():
    from pkg.schemas.application.asset_workspace import AssetClaimDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_claim

    session = AsyncMock()
    proposed_evidence = {**_accepted_evidence(), "status": "proposed", "decided_by": None, "decided_at": None}
    asset = _make_asset(metadata=_workspace_metadata(evidence=[proposed_evidence], claims=[_claim(supporting_evidence=["evidence-1"])]))

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await decide_asset_claim(
                session,
                user_id="user-1",
                asset_id="asset-1",
                claim_id="claim-1",
                body=AssetClaimDecisionRequest(base_workspace_revision=1, decision="accept"),
            )

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_edit_and_accept_claim_preserves_agent_authorship():
    from pkg.schemas.application.asset_workspace import AssetClaimDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_claim

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata(evidence=[_accepted_evidence()], claims=[_claim(supporting_evidence=["evidence-1"])]))

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await decide_asset_claim(
            session,
            user_id="user-1",
            asset_id="asset-1",
            claim_id="claim-1",
            body=AssetClaimDecisionRequest(
                base_workspace_revision=1,
                decision="edit_and_accept",
                edited_content="Agents should receive database access only through capability-scoped gateway tools.",
            ),
        )

    claim = workspace.claims[0]
    assert claim.status == "accepted"
    assert claim.authorship == "agent"
    assert claim.user_edited is True
    assert claim.decided_by == "user-1"
    assert "gateway tools" in claim.content


@pytest.mark.asyncio
async def test_keep_claim_as_hypothesis_does_not_require_supporting_evidence():
    from pkg.schemas.application.asset_workspace import AssetClaimDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_claim

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata(claims=[_claim()]))

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await decide_asset_claim(
            session,
            user_id="user-1",
            asset_id="asset-1",
            claim_id="claim-1",
            body=AssetClaimDecisionRequest(base_workspace_revision=1, decision="keep_as_hypothesis"),
        )

    assert workspace.claims[0].status == "hypothesis"


@pytest.mark.asyncio
async def test_need_more_evidence_creates_scoped_request_with_original_evidence_session():
    from pkg.schemas.application.asset_workspace import AssetClaimDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_claim

    session = AsyncMock()
    evidence = _accepted_evidence()
    evidence["source_session_id"] = "session-evidence-1"
    asset = _make_asset(metadata=_workspace_metadata(
        evidence=[evidence],
        claims=[_claim(supporting_evidence=["evidence-1"])],
    ))

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await decide_asset_claim(
            session,
            user_id="user-1",
            asset_id="asset-1",
            claim_id="claim-1",
            body=AssetClaimDecisionRequest(base_workspace_revision=1, decision="need_more_evidence"),
        )

    request = workspace.missing_evidence_requests[0]
    assert workspace.claims[0].status == "needs_more_evidence"
    assert request.claim_id == "claim-1"
    assert request.scope == ["PostgreSQL", "Harness"]
    assert request.requested_relations == ["supports", "contradicts"]
    assert request.source_session_id == "session-evidence-1"
    assert "capability-scoped" in request.question


@pytest.mark.asyncio
async def test_propose_asset_knowledge_creates_non_promoted_candidates():
    from pkg.schemas.application.asset_workspace import AssetKnowledgeProposalRequest
    from pkg.services.application.asset_workspace import propose_asset_knowledge

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata(
        evidence=[_accepted_evidence()],
        claims=[_accepted_claim()],
    ))
    body = AssetKnowledgeProposalRequest(
        base_workspace_revision=1,
        session_id="session-distill",
        contribution={
            "kind": "decision",
            "summary": "The Asset adds a decision to use capability-scoped database tools.",
            "claim_refs": ["claim-1"],
        },
        candidates=[{
            "candidate_type": "note",
            "action": "create",
            "title": "Capability-scoped database access",
            "content": "Agents should use capability-scoped tools instead of arbitrary SQL access.",
            "claim_refs": ["claim-1"],
        }],
    )

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await propose_asset_knowledge(session, user_id="user-1", asset_id="asset-1", body=body)

    assert workspace.workspace_revision == 2
    assert workspace.contribution is not None
    assert workspace.contribution.status == "proposed"
    assert workspace.contribution.authorship == "agent"
    assert workspace.contribution.attribution is None
    assert workspace.knowledge_candidates[0].status == "proposed"
    assert workspace.knowledge_candidates[0].promoted_at is None


@pytest.mark.asyncio
async def test_propose_asset_knowledge_rejects_unaccepted_claims():
    from pkg.schemas.application.asset_workspace import AssetKnowledgeProposalRequest
    from pkg.services.application.asset_workspace import propose_asset_knowledge

    session = AsyncMock()
    asset = _make_asset(metadata=_workspace_metadata(claims=[_claim()]))
    body = AssetKnowledgeProposalRequest(
        base_workspace_revision=1,
        contribution={
            "kind": "synthesis",
            "summary": "A proposed synthesis.",
            "claim_refs": ["claim-1"],
        },
        candidates=[],
    )

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await propose_asset_knowledge(session, user_id="user-1", asset_id="asset-1", body=body)

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_confirm_asset_contribution_requires_explicit_user_attribution():
    from pkg.schemas.application.asset_workspace import AssetContributionDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_contribution

    metadata = _workspace_metadata(claims=[_accepted_claim()])
    metadata["asset_workspace_v1"]["contribution"] = {
        "id": "contribution-1",
        "kind": "decision",
        "summary": "Use capability-scoped database tools.",
        "claim_refs": ["claim-1"],
        "status": "proposed",
        "authorship": "agent",
        "attribution": None,
        "source_session_id": "session-distill",
        "created_at": "2026-08-28T08:20:00+00:00",
        "decided_by": None,
        "decided_at": None,
        "user_edited": False,
    }
    session = AsyncMock()
    asset = _make_asset(metadata=metadata)

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await decide_asset_contribution(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=AssetContributionDecisionRequest(
                base_workspace_revision=1,
                decision="accept",
                attribution="user_insight",
            ),
        )

    assert workspace.contribution is not None
    assert workspace.contribution.status == "accepted"
    assert workspace.contribution.authorship == "agent"
    assert workspace.contribution.attribution == "user_insight"
    assert workspace.contribution.decided_by == "user-1"


@pytest.mark.asyncio
async def test_keep_knowledge_candidate_does_not_promote_it():
    from pkg.schemas.application.asset_workspace import AssetKnowledgeCandidateDecisionRequest
    from pkg.services.application.asset_workspace import decide_asset_knowledge_candidate

    metadata = _workspace_metadata(claims=[_accepted_claim()])
    metadata["asset_workspace_v1"]["knowledge_candidates"] = [{
        "id": "knowledge-1",
        "candidate_type": "wiki",
        "action": "create",
        "target_wiki_id": None,
        "title": "Database capability boundaries",
        "content": "Use capability-scoped database tools.",
        "claim_refs": ["claim-1"],
        "status": "proposed",
        "authorship": "agent",
        "source_session_id": "session-distill",
        "created_at": "2026-08-28T08:20:00+00:00",
        "decided_by": None,
        "decided_at": None,
        "promoted_at": None,
    }]
    session = AsyncMock()
    asset = _make_asset(metadata=metadata)

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        workspace = await decide_asset_knowledge_candidate(
            session,
            user_id="user-1",
            asset_id="asset-1",
            candidate_id="knowledge-1",
            body=AssetKnowledgeCandidateDecisionRequest(base_workspace_revision=1, decision="keep"),
        )

    candidate = workspace.knowledge_candidates[0]
    assert candidate.status == "kept"
    assert candidate.promoted_at is None


def _accepted_contribution() -> dict:
    return {
        "id": "contribution-1",
        "kind": "decision",
        "summary": "Use capability-scoped database tools.",
        "claim_refs": ["claim-1"],
        "status": "accepted",
        "authorship": "agent",
        "attribution": "agent_synthesis",
        "source_session_id": "session-distill",
        "created_at": "2026-08-28T08:20:00+00:00",
        "decided_by": "user-1",
        "decided_at": "2026-08-28T08:25:00+00:00",
        "user_edited": False,
    }


def _kept_candidate(*, candidate_type: str = "note", action: str = "create", target_wiki_id: str | None = None) -> dict:
    return {
        "id": "knowledge-1",
        "candidate_type": candidate_type,
        "action": action,
        "target_wiki_id": target_wiki_id,
        "title": "Database capability boundaries",
        "content": "Use capability-scoped database tools.",
        "claim_refs": ["claim-1"],
        "status": "kept",
        "authorship": "agent",
        "source_session_id": "session-distill",
        "created_at": "2026-08-28T08:20:00+00:00",
        "decided_by": "user-1",
        "decided_at": "2026-08-28T08:30:00+00:00",
        "promoted_at": None,
    }


@pytest.mark.asyncio
async def test_promote_kept_note_candidate_writes_formal_note_and_traceability():
    from pkg.models.foundation.note import Note
    from pkg.schemas.application.asset_workspace import AssetKnowledgePromotionRequest
    from pkg.services.application.asset_workspace import promote_asset_knowledge_candidate

    metadata = _workspace_metadata(evidence=[_accepted_evidence()], claims=[_accepted_claim()])
    metadata["asset_workspace_v1"]["contribution"] = _accepted_contribution()
    metadata["asset_workspace_v1"]["knowledge_candidates"] = [_kept_candidate()]
    asset = _make_asset(metadata=metadata)
    session = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()

    with (
        patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)),
        patch("pkg.services.application.asset_workspace._add_promotion_embeddings", new=AsyncMock()),
    ):
        workspace = await promote_asset_knowledge_candidate(
            session,
            user_id="user-1",
            asset_id="asset-1",
            candidate_id="knowledge-1",
            body=AssetKnowledgePromotionRequest(base_workspace_revision=1, confirm=True),
        )

    promoted_note = next(call.args[0] for call in session.add.call_args_list if isinstance(call.args[0], Note))
    assert promoted_note.user_id == "user-1"
    assert promoted_note.source_ids == ["source-1"]
    assert "asset-promotion" in promoted_note.tags
    candidate = workspace.knowledge_candidates[0]
    assert candidate.status == "promoted"
    assert candidate.promoted_target_type == "note"
    assert candidate.promoted_target_id == promoted_note.id
    assert asset.note_refs == [promoted_note.id]
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_promote_kept_wiki_candidate_creates_formal_draft_lifecycle():
    from pkg.models.foundation.wiki import WikiPage
    from pkg.schemas.application.asset_workspace import AssetKnowledgePromotionRequest
    from pkg.services.application.asset_workspace import promote_asset_knowledge_candidate

    metadata = _workspace_metadata(evidence=[_accepted_evidence()], claims=[_accepted_claim()])
    metadata["asset_workspace_v1"]["contribution"] = _accepted_contribution()
    metadata["asset_workspace_v1"]["knowledge_candidates"] = [_kept_candidate(candidate_type="wiki")]
    asset = _make_asset(metadata=metadata)
    session = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()

    with (
        patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)),
        patch("pkg.services.application.asset_workspace._add_promotion_embeddings", new=AsyncMock()),
    ):
        await promote_asset_knowledge_candidate(
            session,
            user_id="user-1",
            asset_id="asset-1",
            candidate_id="knowledge-1",
            body=AssetKnowledgePromotionRequest(base_workspace_revision=1, confirm=True),
        )

    promoted_wiki = next(call.args[0] for call in session.add.call_args_list if isinstance(call.args[0], WikiPage))
    assert promoted_wiki.lifecycle_status == "draft"
    assert promoted_wiki.content_revision == 1
    assert promoted_wiki.stable_at is None
    assert promoted_wiki.stable_revision is None
    assert "wiki-draft" in promoted_wiki.tags


@pytest.mark.asyncio
async def test_promote_candidate_requires_accepted_contribution():
    from pkg.schemas.application.asset_workspace import AssetKnowledgePromotionRequest
    from pkg.services.application.asset_workspace import promote_asset_knowledge_candidate

    metadata = _workspace_metadata(claims=[_accepted_claim()])
    metadata["asset_workspace_v1"]["knowledge_candidates"] = [_kept_candidate()]
    asset = _make_asset(metadata=metadata)
    session = AsyncMock()

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await promote_asset_knowledge_candidate(
                session,
                user_id="user-1",
                asset_id="asset-1",
                candidate_id="knowledge-1",
                body=AssetKnowledgePromotionRequest(base_workspace_revision=1, confirm=True),
            )

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_promote_wiki_update_requires_explicit_overwrite_confirmation():
    from pkg.schemas.application.asset_workspace import AssetKnowledgePromotionRequest
    from pkg.services.application.asset_workspace import promote_asset_knowledge_candidate

    metadata = _workspace_metadata(claims=[_accepted_claim()])
    metadata["asset_workspace_v1"]["contribution"] = _accepted_contribution()
    metadata["asset_workspace_v1"]["knowledge_candidates"] = [
        _kept_candidate(candidate_type="wiki", action="update", target_wiki_id="wiki-1")
    ]
    asset = _make_asset(metadata=metadata)
    session = AsyncMock()

    with patch("pkg.services.application.asset_workspace._get_asset_for_update", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await promote_asset_knowledge_candidate(
                session,
                user_id="user-1",
                asset_id="asset-1",
                candidate_id="knowledge-1",
                body=AssetKnowledgePromotionRequest(base_workspace_revision=1, confirm=True),
            )

    assert exc.value.status_code == 409
    assert "overwrite" in exc.value.detail.lower()
