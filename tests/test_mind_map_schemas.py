from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from pkg.schemas.application.mind_map import (
    MindMapCreate,
    MindMapDelete,
    MindMapNodeRead,
    MindMapNodeUpdate,
    MindMapOutlineApply,
    MindMapRead,
    MindMapReferenceRead,
    MindMapTreeRead,
    MindMapUpdate,
    MindMapVersionConflictResponse,
    SourceMindMapGenerationContextRead,
    SourceMindMapProposal,
    SourceMindMapProposalApply,
)


NOW = datetime(2026, 9, 8, tzinfo=UTC)


def make_map(root_node_id: str = "node-root") -> MindMapRead:
    return MindMapRead(
        id="map-1",
        user_id="user-1",
        owner_type="source",
        owner_id="source-1",
        purpose="document_overview",
        title="Distributed systems",
        root_node_id=root_node_id,
        layout_mode="balanced",
        version=3,
        basis_revision={"chunk_revision": 2},
        generation_status="ready",
        created_at=NOW,
        updated_at=NOW,
    )


def make_node(node_id: str, display_id: int, parent_id: str | None) -> MindMapNodeRead:
    return MindMapNodeRead(
        id=node_id,
        map_id="map-1",
        display_id=display_id,
        parent_id=parent_id,
        content=node_id,
        position=display_id - 1,
        node_kind="topic",
        updated_by="human",
        created_at=NOW,
        updated_at=NOW,
    )


def test_create_contract_normalizes_text_and_enforces_owner_purpose() -> None:
    request = MindMapCreate(
        owner_type="source",
        owner_id=" source-1 ",
        purpose="document_overview",
        title=" Document map ",
    )

    assert request.owner_id == "source-1"
    assert request.title == "Document map"
    assert request.layout_mode == "balanced"

    with pytest.raises(ValidationError, match="requires owner_type asset"):
        MindMapCreate(
            owner_type="source",
            owner_id="source-1",
            purpose="asset_outline",
            title="Asset outline",
        )


def test_source_generation_context_excludes_raw_pdf_content() -> None:
    context = SourceMindMapGenerationContextRead(
        source_id="source-1",
        source_metadata={
            "title": "Distributed systems",
            "source_type": "pdf",
            "ingested_at": NOW,
        },
        basis_revision={
            "source_content_hash": "hash-1",
            "chunk_count": 2,
            "chunk_revision": 3,
        },
        input_summary={
            "section_summaries": [
                {"title": "Overview", "summary": "Bounded overview", "chunk_ids": [11, 12]}
            ],
            "chunk_summaries": [
                {"chunk_id": 11, "chunk_index": 0, "summary": "First bounded summary"},
                {"chunk_id": 12, "chunk_index": 1, "summary": "Second bounded summary"},
            ],
        },
    )

    value = context.model_dump(mode="json")
    assert "raw_content" not in value
    assert value["input_summary"]["chunk_summaries"][0]["chunk_id"] == 11


def test_source_proposal_apply_requires_confirmation_and_version_pair() -> None:
    proposal = {
        "source_id": "source-1",
        "basis_revision": {"source_content_hash": "hash-1", "chunk_count": 1, "chunk_revision": None},
        "proposal": {
            "title": "Document map",
            "nodes": [
                {
                    "temp_id": "root",
                    "parent_temp_id": None,
                    "position": 0,
                    "content": "Document map",
                    "node_kind": "topic",
                }
            ],
        },
    }

    with pytest.raises(ValidationError, match="confirm=true"):
        SourceMindMapProposalApply(**proposal, confirm=False)
    with pytest.raises(ValidationError, match="supplied together"):
        SourceMindMapProposalApply(**proposal, confirm=True, map_id="map-1")

    request = SourceMindMapProposalApply(
        **proposal,
        confirm=True,
        map_id="map-1",
        base_version=3,
        session_id=" session-1 ",
    )
    assert request.session_id == "session-1"


def test_versioned_updates_require_an_explicit_change() -> None:
    with pytest.raises(ValidationError, match="at least one map field"):
        MindMapUpdate(base_version=3)

    note_clear = MindMapNodeUpdate(base_version=3, note=None)
    assert "note" in note_clear.model_fields_set
    assert note_clear.note is None

    with pytest.raises(ValidationError):
        MindMapDelete(base_version=3, confirm=False)


def test_replace_outline_requires_explicit_confirmation() -> None:
    with pytest.raises(ValidationError, match="confirm_replace=true"):
        MindMapOutlineApply(base_version=3, mode="replace", outline="- Root")

    request = MindMapOutlineApply(
        base_version=3,
        mode="replace",
        outline="\n- [id:1] Root\n  - Branch\n",
        confirm_replace=True,
    )
    assert request.outline == "- [id:1] Root\n  - Branch"


def test_tree_contract_accepts_flat_xyflow_shape_with_references() -> None:
    root = make_node("node-root", 1, None)
    child = make_node("node-child", 2, root.id)
    reference = MindMapReferenceRead(
        id="reference-1",
        map_id="map-1",
        node_id=child.id,
        ref_type="source_chunk",
        ref_id="chunk-1",
        relation="derived_from",
        fragment_selector={"page": 18},
        created_at=NOW,
    )

    tree = MindMapTreeRead(
        map=make_map(),
        root_id=root.id,
        nodes=[root, child],
        references=[reference],
    )

    assert tree.root_id == "node-root"
    assert tree.nodes[1].parent_id == "node-root"
    assert tree.references[0].fragment_selector == {"page": 18}


@pytest.mark.parametrize(
    ("nodes", "message"),
    [
        ([make_node("node-root", 1, None), make_node("node-child", 2, "missing")], "missing parent"),
        (
            [
                make_node("node-root", 1, None),
                make_node("node-a", 2, "node-b"),
                make_node("node-b", 3, "node-a"),
            ],
            "contains a cycle",
        ),
    ],
)
def test_tree_contract_rejects_invalid_parent_graph(nodes: list[MindMapNodeRead], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        MindMapTreeRead(map=make_map(), root_id="node-root", nodes=nodes)


def test_version_conflict_response_is_structured_for_clients() -> None:
    response = MindMapVersionConflictResponse(
        detail={
            "message": "Mind Map version changed: expected 8, current 9",
            "map_id": "map-1",
            "expected_version": 8,
            "current_version": 9,
        }
    )

    assert response.detail.code == "mind_map_version_conflict"
    assert response.detail.expected_version == 8
    assert response.detail.current_version == 9


def test_source_proposal_accepts_a_bounded_tree_with_chunk_references() -> None:
    proposal = SourceMindMapProposal(
        title=" Distributed systems overview ",
        nodes=[
            {
                "temp_id": "root",
                "parent_temp_id": None,
                "position": 0,
                "content": "Distributed systems",
                "node_kind": "topic",
            },
            {
                "temp_id": "claim-1",
                "parent_temp_id": "root",
                "position": 0,
                "content": "Coordination requires explicit failure handling",
                "node_kind": "claim",
            },
        ],
        references=[
            {
                "node_temp_id": "claim-1",
                "chunk_id": 12,
                "relation": "supports",
                "fragment_selector": {"page": 8, "quote": "explicit failure handling"},
            }
        ],
    )

    assert proposal.title == "Distributed systems overview"
    assert proposal.nodes[1].parent_temp_id == "root"
    assert proposal.references[0].fragment_selector.page == 8


@pytest.mark.parametrize(
    ("nodes", "references", "message"),
    [
        (
            [
                {"temp_id": "root", "parent_temp_id": None, "position": 0, "content": "Root", "node_kind": "topic"},
                {"temp_id": "claim", "parent_temp_id": "root", "position": 0, "content": "Claim", "node_kind": "claim"},
            ],
            [],
            "factual proposal nodes require source chunk references",
        ),
        (
            [
                {"temp_id": "root", "parent_temp_id": None, "position": 0, "content": "Root", "node_kind": "topic"},
                {"temp_id": "a", "parent_temp_id": "b", "position": 0, "content": "A", "node_kind": "concept"},
                {"temp_id": "b", "parent_temp_id": "a", "position": 0, "content": "B", "node_kind": "concept"},
            ],
            [],
            "proposal contains a cycle",
        ),
    ],
)
def test_source_proposal_rejects_untraceable_or_invalid_trees(
    nodes: list[dict],
    references: list[dict],
    message: str,
) -> None:
    with pytest.raises(ValidationError, match=message):
        SourceMindMapProposal(title="Invalid", nodes=nodes, references=references)


def test_source_proposal_rejects_more_than_eighty_nodes() -> None:
    nodes = [
        {
            "temp_id": "root" if index == 0 else f"node-{index}",
            "parent_temp_id": None if index == 0 else "root",
            "position": 0 if index == 0 else index - 1,
            "content": f"Node {index}",
            "node_kind": "topic" if index == 0 else "concept",
        }
        for index in range(81)
    ]

    with pytest.raises(ValidationError):
        SourceMindMapProposal(title="Too large", nodes=nodes)
