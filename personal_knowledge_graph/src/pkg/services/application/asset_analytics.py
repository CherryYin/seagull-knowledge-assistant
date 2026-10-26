from collections import Counter, defaultdict
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset, AssetVisual
from pkg.models.application.mind_map import MindMap
from pkg.models.application.project import ProjectResource
from pkg.schemas.application.asset_analytics import (
    AssetAnalytics,
    AssetFeatureCounts,
    AssetFeatureIssue,
    AssetFeatureState,
    AssetVisualMetrics,
)
from pkg.services.application.asset_workspace import audit_asset_workspace
from pkg.services.application.blog_generation import check_readiness
from pkg.services.application.mind_maps import build_asset_outline_proposal
from pkg.services.application.projects import owned_project

FEATURES = [
    ("intent", "Intent confirmation", False),
    ("evidence", "Evidence and evidence gaps", False),
    ("claims", "Claims and conclusions", False),
    ("draft", "Draft generation", False),
    ("blocks", "Content blocks and Claim links", False),
    ("optimization", "Whole-document optimization", True),
    ("quality", "Quality checks", True),
    ("outline", "Outline maps", True),
    ("visuals", "Image generation and review", True),
    ("export", "Markdown / HTML export", False),
    ("wechat", "WeChat draft delivery", True),
    ("knowledge", "Knowledge distillation and promotion", True),
]
FEATURE_IDS = {item[0] for item in FEATURES}


def _records(value) -> list[dict]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _asset_states(asset: Asset, visuals: list[AssetVisual], maps: list[MindMap]):
    metadata = asset.metadata_ if isinstance(asset.metadata_, dict) else {}
    workspace = metadata.get("asset_workspace_v1")
    workspace = workspace if isinstance(workspace, dict) else None
    states: dict[str, tuple[AssetFeatureState, list[tuple[str, list[str]]]]] = {}

    def record(feature: str, state: AssetFeatureState, reasons: list[str] | None = None):
        states[feature] = (state, [(reason, []) for reason in reasons or []])

    gate_reasons: list[str] = []
    if workspace is None:
        for feature in ("intent", "evidence", "claims", "optimization", "quality", "knowledge"):
            record(feature, "unknown")
    else:
        intent = workspace.get("intent")
        confirmed = isinstance(intent, dict) and intent.get("status") == "confirmed"
        revision = intent.get("revision") if isinstance(intent, dict) else None
        evidence = [item for item in _records(workspace.get("evidence")) if item.get("intent_revision") == revision]
        claims = [item for item in _records(workspace.get("claims")) if item.get("intent_revision") == revision]
        accepted_evidence = any(item.get("status") == "accepted" for item in evidence)
        pending_evidence = any(item.get("status") == "proposed" for item in evidence)
        accepted_claims = any(item.get("status") in {"accepted", "hypothesis"} for item in claims)
        pending_claims = any(item.get("status") == "proposed" for item in claims)
        evidence_gaps = any(item.get("status") == "open" and item.get("intent_revision") == revision
                            for item in _records(workspace.get("missing_evidence_requests")))
        need_evidence = any(item.get("status") == "needs_more_evidence" for item in claims)
        record("intent", "completed" if confirmed else "needs_review", [] if confirmed else ["Confirm the current Intent"])
        if not confirmed:
            gate_reasons.append("Confirm the current Intent")
            record("evidence", "blocked", ["Intent is not confirmed"])
        elif evidence_gaps:
            record("evidence", "blocked", ["Resolve open evidence gap requests"])
        elif pending_evidence:
            record("evidence", "needs_review", ["Decide proposed Evidence"])
        else:
            record("evidence", "completed" if accepted_evidence else "not_started")
        if not accepted_evidence:
            gate_reasons.append("Accept current Evidence")
        if pending_evidence:
            gate_reasons.append("Decide proposed Evidence")
        if need_evidence:
            record("claims", "blocked", ["Claims explicitly need more Evidence"])
        elif not confirmed or not accepted_evidence or pending_evidence:
            record("claims", "blocked", ["Complete the current Intent and Evidence gates"])
        elif pending_claims:
            record("claims", "needs_review", ["Decide proposed Claims"])
        else:
            record("claims", "completed" if accepted_claims else "not_started")
        if not accepted_claims:
            gate_reasons.append("Accept a current Claim or retain a Hypothesis")
        if pending_claims:
            gate_reasons.append("Decide proposed Claims")
        optimization = metadata.get("asset_optimization_v1")
        rounds = optimization.get("completed_rounds") if isinstance(optimization, dict) else None
        if type(rounds) is int and rounds > 0:
            record("optimization", "completed")
        elif not (asset.draft_content or "").strip():
            record("optimization", "not_started")
        elif gate_reasons:
            record("optimization", "blocked", gate_reasons)
        else:
            record("optimization", "not_started")
        if (asset.draft_content or "").strip():
            audit_workspace = {**workspace, "evidence": evidence, "claims": claims,
                               "knowledge_candidates": _records(workspace.get("knowledge_candidates"))}
            audit = audit_asset_workspace(asset, audit_workspace)
            record("quality", "blocked" if audit.blocking_findings else "needs_review" if audit.warnings else "completed",
                   [item.title for item in audit.blocking_findings or audit.warnings])
        else:
            record("quality", "not_started")
        candidates = _records(workspace.get("knowledge_candidates"))
        contribution = workspace.get("contribution")
        if any(item.get("status") == "promoted" for item in candidates):
            record("knowledge", "completed")
        elif any(item.get("status") in {"proposed", "kept"} for item in candidates) or (
            isinstance(contribution, dict) and contribution.get("status") == "proposed"
        ):
            record("knowledge", "needs_review", ["Review Contribution or Knowledge Candidates"])
        else:
            record("knowledge", "not_started")

    has_draft = bool((asset.draft_content or "").strip())
    record("draft", "completed" if has_draft else "blocked" if workspace is not None and gate_reasons else "not_started",
           gate_reasons if not has_draft and workspace is not None else [])
    document = metadata.get("asset_document")
    blocks = _records(document.get("blocks")) if isinstance(document, dict) and document.get("schema_version") == 1 else []
    if not blocks:
        record("blocks", "needs_review" if has_draft else "not_started", ["Establish stable Blocks for block editing and maps"] if has_draft else [])
    else:
        intent = (workspace or {}).get("intent")
        current_revision = intent.get("revision") if isinstance(intent, dict) else None
        known_claims = {item.get("id") for item in _records((workspace or {}).get("claims"))
                        if item.get("status") in {"accepted", "hypothesis"}
                        and item.get("intent_revision") == current_revision}
        block_issues = []
        for block in blocks:
            block_id = str(block.get("id") or "")
            refs = block.get("claim_refs", block.get("claimRefs", []))
            if not block_id or type(block.get("revision")) is not int or block["revision"] < 1:
                block_issues.append(("Invalid stable Block ID or revision", [block_id] if block_id else []))
            if not isinstance(refs, list) or any(not isinstance(ref, str) or ref not in known_claims for ref in refs):
                block_issues.append(("Block references a missing or unaccepted Claim", [block_id] if block_id else []))
            if not str(block.get("markdown") or "").strip():
                block_issues.append(("Empty content Block", [block_id] if block_id else []))
        states["blocks"] = ("blocked" if block_issues else "completed", block_issues)

    outline = [item for item in maps if item.purpose == "asset_outline"]
    if any(item.generation_status == "failed" for item in outline):
        record("outline", "failed", ["Outline map has a recorded failure"])
    elif any(item.generation_status == "stale" for item in outline):
        record("outline", "needs_review", ["Refresh the stale Outline Map"])
    elif any(item.generation_status == "generating" for item in outline):
        record("outline", "in_progress")
    elif outline:
        try:
            current_basis = build_asset_outline_proposal(asset).basis_revision.model_dump()
        except HTTPException as error:
            if error.status_code not in {409, 422}:
                raise
            record("outline", "blocked", [str(error.detail)])
        else:
            keys = ("workspace_revision", "intent_revision", "asset_document_revision", "base_document_signature")
            changed = any(any((item.basis_revision or {}).get(key) != current_basis[key] for key in keys) for item in outline)
            record("outline", "needs_review" if changed else "completed", ["Outline Map basis differs from the saved document or workspace"] if changed else [])
    else:
        record("outline", "not_started")
    if any(item.status == "accepted" for item in visuals):
        record("visuals", "completed")
    elif any(item.status in {"queued", "generating", "retrying"} for item in visuals):
        record("visuals", "in_progress")
    elif any(item.status == "ready" for item in visuals):
        record("visuals", "needs_review", ["Review ready image candidates"])
    elif any(item.status == "failed" for item in visuals):
        record("visuals", "failed", ["Image candidates have recorded generation failures"])
    else:
        record("visuals", "not_started")

    if asset.exported_at or asset.status in {"exported", "published"}:
        record("export", "completed")
    elif not has_draft:
        record("export", "not_started")
    else:
        _, export_blockers, _, _ = check_readiness(asset)
        if not (asset.reference_notes or "").strip():
            export_blockers.append("Attach a references section before export")
        record("export", "blocked" if export_blockers else "not_started", export_blockers)
    wechat = metadata.get("wechat_draft")
    record("wechat", "completed" if isinstance(wechat, dict) and wechat.get("media_id") else "unknown" if asset.export_format == "wechat_draft" else "not_started")
    return states


def summarize_asset_features(
    assets: list[Asset], visuals: list[AssetVisual], maps: list[MindMap], *,
    feature: str | None = None, offset: int = 0, limit: int = 50,
) -> AssetAnalytics:
    owned_ids = {asset.id for asset in assets}
    owners = {asset.id: asset.user_id for asset in assets}
    visuals = [item for item in visuals if item.asset_id in owned_ids and item.user_id == owners[item.asset_id]]
    maps = [item for item in maps if item.owner_type == "asset" and item.owner_id in owned_ids and item.user_id == owners[item.owner_id]]
    visual_groups = defaultdict(list)
    map_groups = defaultdict(list)
    for visual in visuals:
        visual_groups[visual.asset_id].append(visual)
    for mind_map in maps:
        map_groups[mind_map.owner_id].append(mind_map)
    counts = {key: AssetFeatureCounts(feature=key, label=label, optional=optional,
              recorded_failure_assets=0 if key in {"visuals", "outline"} else None)
              for key, label, optional in FEATURES}
    issues: list[AssetFeatureIssue] = []
    attention_assets = set()
    for asset in assets:
        states = _asset_states(asset, visual_groups[asset.id], map_groups[asset.id])
        for key, (state, reasons) in states.items():
            setattr(counts[key], state, getattr(counts[key], state) + 1)
            for reason in {item[0] for item in reasons}:
                counts[key].reasons[reason] = counts[key].reasons.get(reason, 0) + 1
            for reason, block_ids in reasons:
                if state in {"blocked", "needs_review", "failed"}:
                    attention_assets.add(asset.id)
                    issues.append(AssetFeatureIssue(asset_id=asset.id, title=asset.title,
                        asset_type=asset.asset_type, asset_status=asset.status, feature=key,
                        state=state, reason=reason, block_ids=block_ids))
        if any(item.status == "failed" for item in visual_groups[asset.id]):
            counts["visuals"].recorded_failure_assets += 1
        if any(item.generation_status == "failed" for item in map_groups[asset.id] if item.purpose == "asset_outline"):
            counts["outline"].recorded_failure_assets += 1
    filtered_issues = [item for item in issues if feature is None or item.feature == feature]
    elapsed = [(item.completed_at - item.created_at).total_seconds() for item in visuals
               if item.completed_at and item.created_at and item.completed_at >= item.created_at]
    attempts = [max(0, item.processing_attempts or 0) for item in visuals]
    return AssetAnalytics(
        generated_at=datetime.now(timezone.utc), total_assets=len(assets),
        assets_with_attention=len(attention_assets),
        assets_without_workspace=sum(not isinstance((asset.metadata_ or {}).get("asset_workspace_v1"), dict) for asset in assets),
        by_type=dict(Counter(asset.asset_type for asset in assets)),
        by_status=dict(Counter(asset.status for asset in assets)), features=list(counts.values()),
        visual_metrics=AssetVisualMetrics(total_tasks=len(visuals),
            failed_tasks=sum(item.status == "failed" for item in visuals),
            active_tasks=sum(item.status in {"queued", "generating", "retrying"} for item in visuals),
            processing_attempts=sum(attempts), retry_attempts=sum(max(0, value - 1) for value in attempts),
            timed_tasks=len(elapsed), mean_elapsed_seconds=sum(elapsed) / len(elapsed) if elapsed else None),
        issues=filtered_issues[offset:offset + limit], issue_total=len(filtered_issues),
        issue_offset=offset, issue_limit=limit,
        measurement_limits=[
            "Counts cover every owned Asset matching the filters, including those without a review note.",
            "Blocked means a persisted prerequisite or validation issue, not proof that a user actually stopped.",
            "Optional features that were never used are not counted as failures or required completion steps.",
            "Failure coverage is limited to retained visual tasks and Outline Map status; other request failures are not recorded.",
            "Completed means a saved record exists, not verified adoption, current validity, or measured feature usage.",
            "Per-stage wait, manual recovery, Harness retry and Token usage are not uniformly recorded.",
            "Visual elapsed time includes queueing and retry delays, not pure model inference latency.",
        ],
    )


async def get_asset_analytics(
    session: AsyncSession, *, user_id: str, asset_type: str | None = None,
    status: str | None = None, feature: str | None = None, offset: int = 0, limit: int = 50,
    project_id: str | None = None,
) -> AssetAnalytics:
    filters = [Asset.user_id == user_id]
    project = None
    if project_id:
        project = await owned_project(session, user_id, project_id)
        linked_assets = select(ProjectResource.asset_id).where(
            ProjectResource.project_id == project.id, ProjectResource.resource_type == "asset")
        filters.append(Asset.id.in_(linked_assets))
    if asset_type:
        filters.append(Asset.asset_type == asset_type)
    if status:
        filters.append(Asset.status == status)
    assets_result = await session.execute(select(Asset).where(*filters).order_by(Asset.updated_at.desc(), Asset.id))
    assets = list(assets_result.scalars())
    visuals, maps = [], []
    if assets:
        visuals_result = await session.execute(select(AssetVisual).join(Asset, Asset.id == AssetVisual.asset_id)
            .where(AssetVisual.user_id == user_id, *filters))
        maps_result = await session.execute(select(MindMap).join(Asset, Asset.id == MindMap.owner_id)
            .where(MindMap.user_id == user_id, MindMap.owner_type == "asset", *filters))
        visuals, maps = list(visuals_result.scalars()), list(maps_result.scalars())
    result = summarize_asset_features(assets, visuals, maps, feature=feature, offset=offset, limit=limit)
    if project:
        result.project_id, result.project_title, result.project_archived = project.id, project.title, bool(project.archived_at)
        result.measurement_limits.append("Project scope includes only directly linked owned Assets, counted once; task and session activity is not inferred. Archived Projects remain readable.")
    return result
