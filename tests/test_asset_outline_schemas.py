"""Schema tests for M3 Asset Outline proposals and editor patches."""

import pytest
from pydantic import ValidationError

from pkg.models.application.asset import Asset
from pkg.schemas.application.mind_map import AssetOutlinePatch, AssetOutlineProposal, AssetOutlineRefreshApply
from pkg.services.application.mind_maps import build_asset_outline_proposal


def _basis():
    return {
        "workspace_revision": 12,
        "intent_revision": 2,
        "asset_document_revision": 7,
        "base_document_signature": "document-signature-7",
        "accepted_claim_ids": ["claim-1", "claim-2"],
    }


def test_asset_outline_proposal_accepts_one_block_node_per_asset_block():
    proposal = AssetOutlineProposal.model_validate({
        "asset_id": "asset-1",
        "title": "Architecture Brief Outline",
        "basis_revision": _basis(),
        "nodes": [
            {"temp_id": "root", "parent_temp_id": None, "position": 0, "content": "Architecture Brief", "node_kind": "topic"},
            {"temp_id": "summary", "parent_temp_id": "root", "position": 0, "content": "Executive Summary", "node_kind": "section", "asset_block_id": "block-1", "claim_refs": ["claim-1"]},
            {"temp_id": "detail", "parent_temp_id": "summary", "position": 0, "content": "Gateway boundary", "node_kind": "block", "asset_block_id": "block-2", "claim_refs": ["claim-2"]},
        ],
    })

    assert proposal.layout_mode == "right"
    assert proposal.nodes[2].asset_block_id == "block-2"
    assert proposal.requires_user_confirmation is True
    assert proposal.writes_asset is False


@pytest.mark.parametrize(
    ("nodes", "message"),
    [
        (
            [
                {"temp_id": "root", "parent_temp_id": None, "position": 0, "content": "Asset", "node_kind": "topic"},
                {"temp_id": "one", "parent_temp_id": "root", "position": 0, "content": "One", "node_kind": "block", "asset_block_id": "block-1"},
                {"temp_id": "two", "parent_temp_id": "root", "position": 1, "content": "Two", "node_kind": "block", "asset_block_id": "block-1"},
            ],
            "references an Asset Block more than once",
        ),
        (
            [
                {"temp_id": "root", "parent_temp_id": None, "position": 0, "content": "Asset", "node_kind": "topic"},
                {"temp_id": "one", "parent_temp_id": "root", "position": 0, "content": "One", "node_kind": "block", "asset_block_id": "block-1", "claim_refs": ["claim-unreviewed"]},
            ],
            "references unaccepted Claims",
        ),
    ],
)
def test_asset_outline_proposal_rejects_unsafe_references(nodes, message):
    with pytest.raises(ValidationError, match=message):
        AssetOutlineProposal.model_validate({
            "asset_id": "asset-1",
            "title": "Unsafe Outline",
            "basis_revision": _basis(),
            "nodes": nodes,
        })


def test_asset_outline_patch_supports_previewable_structural_changes():
    patch = AssetOutlinePatch.model_validate({
        "asset_id": "asset-1",
        "map_id": "map-1",
        "base_map_version": 3,
        "basis_revision": _basis(),
        "explanation": "Move the recommendation forward and make the risk section explicit.",
        "operations": [
            {"operation": "add", "temp_block_id": "new-risk", "after_block_id": "block-2", "markdown": "## Risks", "claim_refs": ["claim-2"]},
            {"operation": "move", "block_id": "block-3", "base_block_revision": 2, "after_block_id": "block-1"},
            {"operation": "rename", "block_id": "block-1", "base_block_revision": 1, "replacement_markdown": "## Executive Recommendation"},
            {"operation": "delete", "block_id": "block-4", "base_block_revision": 1, "affected_claim_refs": ["claim-1"]},
        ],
    })

    assert [operation.operation for operation in patch.operations] == ["add", "move", "rename", "delete"]
    assert patch.requires_user_confirmation is True
    assert patch.writes_asset is False


def test_asset_outline_refresh_apply_requires_explicit_confirmation():
    proposal = AssetOutlineProposal.model_validate({
        "asset_id": "asset-1",
        "title": "Architecture Brief Outline",
        "basis_revision": _basis(),
        "nodes": [
            {"temp_id": "root", "parent_temp_id": None, "position": 0, "content": "Architecture Brief", "node_kind": "topic"},
            {"temp_id": "summary", "parent_temp_id": "root", "position": 0, "content": "Executive Summary", "node_kind": "section", "asset_block_id": "block-1", "claim_refs": ["claim-1"]},
        ],
    })

    applied = AssetOutlineRefreshApply(base_version=3, proposal=proposal, confirm=True)
    assert applied.confirm is True

    with pytest.raises(ValidationError):
        AssetOutlineRefreshApply(base_version=3, proposal=proposal, confirm=False)


@pytest.mark.parametrize(
    ("operations", "message"),
    [
        (
            [
                {"operation": "delete", "block_id": "block-1", "base_block_revision": 1, "affected_claim_refs": []},
                {"operation": "move", "block_id": "block-1", "base_block_revision": 1, "after_block_id": "block-2"},
            ],
            "cannot also be moved or renamed",
        ),
        (
            [{"operation": "add", "temp_block_id": "new", "markdown": "## New", "claim_refs": ["claim-unreviewed"]}],
            "adds unaccepted Claims",
        ),
        (
            [
                {"operation": "delete", "block_id": "block-2", "base_block_revision": 1, "affected_claim_refs": []},
                {"operation": "move", "block_id": "block-1", "base_block_revision": 1, "after_block_id": "block-2"},
            ],
            "after a deleted Block",
        ),
    ],
)
def test_asset_outline_patch_rejects_ambiguous_or_unsafe_operations(operations, message):
    with pytest.raises(ValidationError, match=message):
        AssetOutlinePatch.model_validate({
            "asset_id": "asset-1",
            "map_id": "map-1",
            "base_map_version": 3,
            "basis_revision": _basis(),
            "operations": operations,
        })


def test_asset_blocks_project_to_heading_hierarchy_with_stable_references():
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="research_brief",
        status="draft",
        title="Gateway Architecture",
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        metadata_={
            "asset_workspace_v1": {
                "workspace_revision": 12,
                "intent": {"revision": 2, "status": "confirmed"},
                "claims": [{"id": "claim-1", "status": "accepted"}],
            },
            "asset_document": {
                "schemaVersion": 1,
                "revision": 7,
                "blocks": [
                    {"id": "block-1", "type": "heading", "markdown": "## Findings", "revision": 1, "claim_refs": []},
                    {"id": "block-2", "type": "paragraph", "markdown": "Use a capability-scoped gateway.", "revision": 2, "claim_refs": ["claim-1"]},
                    {"id": "block-3", "type": "heading", "markdown": "### Risks", "revision": 1, "claim_refs": []},
                ],
            },
        },
    )

    proposal = build_asset_outline_proposal(asset)

    assert proposal.nodes[1].parent_temp_id == "root"
    assert proposal.nodes[2].parent_temp_id == proposal.nodes[1].temp_id
    assert proposal.nodes[3].parent_temp_id == proposal.nodes[1].temp_id
    assert [node.asset_block_id for node in proposal.nodes[1:]] == ["block-1", "block-2", "block-3"]
    assert proposal.basis_revision.asset_document_revision == 7
    assert proposal.basis_revision.base_document_signature.startswith("document-")
