from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.models.application.asset import Asset, AssetVisual
from pkg.models.application.mind_map import MindMap
from pkg.services.application.asset_analytics import get_asset_analytics, summarize_asset_features
from pkg.services.application.mind_maps import build_asset_outline_proposal


def make_asset(asset_id="asset-1", *, metadata=None, draft="Saved draft", user_id="user-1"):
    return Asset(id=asset_id, user_id=user_id, title=asset_id, asset_type="blog_post",
        status="draft", brief="A real question", outline="An outline", draft_content=draft,
        reference_notes="- Reference", source_refs=["source-1"], note_refs=[], wiki_refs=[],
        metadata_=metadata or {}, created_at=datetime(2026, 10, 12, tzinfo=timezone.utc),
        updated_at=datetime(2026, 10, 12, tzinfo=timezone.utc))


def workspace_metadata():
    return {"asset_workspace_v1": {
        "workspace_revision": 1,
        "intent": {"status": "confirmed", "revision": 2},
        "evidence": [{"id": "evidence-1", "status": "accepted", "intent_revision": 2}],
        "claims": [{"id": "claim-1", "status": "accepted", "intent_revision": 2,
                    "supporting_evidence": ["evidence-1"], "contradicting_evidence": []}],
        "knowledge_candidates": [],
    }, "asset_document": {"schema_version": 1, "revision": 1,
        "blocks": [{"id": "block-1", "revision": 1, "markdown": "# Saved draft", "claim_refs": ["claim-1"]}]}}


def feature(result, key):
    return next(item for item in result.features if item.feature == key)


def make_visual(asset_id, status, *, user_id="user-1", attempts=1, elapsed=None):
    created_at = datetime(2026, 10, 12, tzinfo=timezone.utc)
    return AssetVisual(id=f"visual-{asset_id}-{status}", asset_id=asset_id, user_id=user_id,
        role="cover", status=status, prompt="Private prompt", model="test-image-model",
        processing_attempts=attempts, created_at=created_at,
        completed_at=created_at + timedelta(seconds=elapsed) if elapsed is not None else None)


def test_global_analytics_covers_all_assets_and_treats_missing_workspaces_as_unknown():
    assets = [make_asset(f"asset-{index}") for index in range(251)]
    result = summarize_asset_features(assets, [], [], limit=10)
    assert result.total_assets == 251
    assert result.assets_without_workspace == 251
    assert feature(result, "intent").unknown == 251
    assert feature(result, "draft").completed == 251
    assert feature(result, "visuals").not_started == 251
    assert feature(result, "visuals").failed == 0
    assert feature(result, "outline").not_started == 251
    assert feature(result, "wechat").not_started == 251
    assert feature(result, "export").recorded_failure_assets is None
    assert len(result.issues) == 10
    assert result.issue_total == 251
    for counts in result.features:
        assert sum(getattr(counts, key) for key in ("completed", "blocked", "needs_review", "in_progress", "not_started", "unknown", "failed")) == 251


def test_global_analytics_counts_current_gates_and_links_issues_to_specific_blocks():
    metadata = workspace_metadata()
    metadata["asset_workspace_v1"]["evidence"] = [{"id": "old", "intent_revision": 1, "status": "accepted"}]
    metadata["asset_workspace_v1"]["claims"] = [{"id": "old-claim", "intent_revision": 1, "status": "accepted"}]
    result = summarize_asset_features([make_asset(metadata=metadata, draft=None)], [], [])
    assert feature(result, "claims").blocked == 1
    assert feature(result, "draft").blocked == 1
    assert feature(result, "blocks").blocked == 1
    block_issue = next(item for item in result.issues if item.feature == "blocks")
    assert block_issue.block_ids == ["block-1"]
    assert result.assets_with_attention == 1
    assert feature(result, "optimization").not_started == 1


def test_global_analytics_distinguishes_explicit_evidence_gaps_pending_decisions_and_saved_rounds():
    metadata = workspace_metadata()
    metadata["asset_workspace_v1"]["missing_evidence_requests"] = [{"status": "open", "intent_revision": 2}]
    metadata["asset_workspace_v1"]["claims"][0]["status"] = "needs_more_evidence"
    metadata["asset_optimization_v1"] = {"completed_rounds": 2}
    result = summarize_asset_features([make_asset(metadata=metadata)], [], [])
    assert feature(result, "evidence").blocked == 1
    assert feature(result, "claims").blocked == 1
    assert feature(result, "optimization").completed == 1
    metadata["asset_workspace_v1"]["missing_evidence_requests"] = []
    metadata["asset_workspace_v1"]["evidence"][0]["status"] = "proposed"
    result = summarize_asset_features([make_asset(metadata=metadata)], [], [])
    assert feature(result, "evidence").needs_review == 1


def test_global_analytics_ignores_old_evidence_gaps_and_rejects_old_claim_block_links():
    metadata = workspace_metadata()
    metadata["asset_workspace_v1"]["missing_evidence_requests"] = [{"status": "open", "intent_revision": 1}]
    metadata["asset_workspace_v1"]["claims"][0]["intent_revision"] = 1
    result = summarize_asset_features([make_asset(metadata=metadata)], [], [])
    assert feature(result, "evidence").completed == 1
    assert feature(result, "blocks").blocked == 1
    assert next(item for item in result.issues if item.feature == "blocks").block_ids == ["block-1"]


def test_global_analytics_counts_visual_failures_without_erasing_an_accepted_candidate():
    assets = [make_asset("asset-a"), make_asset("asset-b")]
    visuals = [make_visual("asset-a", "accepted", attempts=2, elapsed=90),
               make_visual("asset-a", "failed", attempts=3, elapsed=120),
               make_visual("asset-b", "ready", attempts=0),
               make_visual("asset-a", "failed", user_id="other-user", elapsed=999),
               make_visual("foreign", "failed", elapsed=999)]
    result = summarize_asset_features(assets, visuals, [])
    assert feature(result, "visuals").completed == 1
    assert feature(result, "visuals").needs_review == 1
    assert feature(result, "visuals").recorded_failure_assets == 1
    assert result.visual_metrics.total_tasks == 3
    assert result.visual_metrics.failed_tasks == 1
    assert result.visual_metrics.retry_attempts == 3
    assert result.visual_metrics.mean_elapsed_seconds == 105
    assert result.visual_metrics.timed_tasks == 2


def test_global_analytics_detects_stale_outline_basis_without_writing_or_requiring_map_visits():
    asset = make_asset(metadata=workspace_metadata())
    basis = build_asset_outline_proposal(asset).basis_revision.model_dump()
    mind_map = MindMap(id="map-1", user_id="user-1", owner_type="asset", owner_id=asset.id,
                      purpose="asset_outline", title="Map", generation_status="ready", basis_revision=basis)
    result = summarize_asset_features([asset], [], [mind_map])
    assert feature(result, "outline").completed == 1
    mind_map.basis_revision = {**basis, "workspace_revision": 0}
    result = summarize_asset_features([asset], [], [mind_map])
    assert feature(result, "outline").needs_review == 1
    assert mind_map.generation_status == "ready"


def test_global_analytics_paginates_details_without_changing_full_feature_totals():
    assets = [make_asset(f"asset-{index}") for index in range(5)]
    result = summarize_asset_features(assets, [], [], feature="blocks", offset=2, limit=2)
    assert result.total_assets == 5
    assert feature(result, "blocks").needs_review == 5
    assert result.issue_total == 5
    assert [item.asset_id for item in result.issues] == ["asset-2", "asset-3"]
    assert summarize_asset_features([], [], []).visual_metrics.mean_elapsed_seconds is None


class ScalarResult:
    def __init__(self, values):
        self.values = values

    def scalars(self):
        return iter(self.values)


@pytest.mark.asyncio
async def test_global_analytics_queries_are_user_scoped_and_batched_not_asset_paginated():
    session = AsyncMock()
    session.execute.side_effect = [ScalarResult([make_asset()]), ScalarResult([]), ScalarResult([])]
    result = await get_asset_analytics(session, user_id="user-1", asset_type="blog_post", status="draft")
    assert result.total_assets == 1
    assert session.execute.await_count == 3
    for call in session.execute.await_args_list:
        sql = str(call.args[0].compile(compile_kwargs={"literal_binds": True}))
        assert "user-1" in sql
        assert "assets.user_id" in sql
        assert "assets.asset_type" in sql
        assert "LIMIT" not in sql
    session.commit.assert_not_awaited()
    session.add.assert_not_called()


@pytest.mark.asyncio
async def test_global_analytics_route_uses_authenticated_owner_and_validates_features():
    from pkg.api.assets import asset_analytics_route

    session = AsyncMock()
    owner = MagicMock(id="user-1")
    expected = summarize_asset_features([], [], [])
    with patch("pkg.api.assets.get_asset_analytics", new=AsyncMock(return_value=expected)) as service:
        result = await asset_analytics_route(user=owner, session=session, asset_type=None, status=None,
                                            feature="visuals", offset=0, limit=30)
    assert result.total_assets == 0
    service.assert_awaited_once_with(session, user_id="user-1", asset_type=None, status=None,
                                   feature="visuals", offset=0, limit=30)
    with pytest.raises(HTTPException) as error:
        await asset_analytics_route(user=owner, session=session, feature="unknown")
    assert error.value.status_code == 422
