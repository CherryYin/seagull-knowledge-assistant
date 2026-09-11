from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.api.app import app
from pkg.api.mind_maps import (
    add_mind_map_node_route,
    apply_asset_outline_refresh_proposal_route,
    apply_source_mind_map_proposal_route,
    apply_mind_map_outline_route,
    build_asset_outline_refresh_proposal_route,
    build_asset_outline_document_patch_route,
    check_asset_outline_staleness_route,
    check_mind_map_staleness_route,
    create_mind_map_reference_route,
    create_mind_map_route,
    delete_mind_map_route,
    get_source_mind_map_generation_context_route,
    restore_mind_map_revision_route,
    update_mind_map_route,
    validate_source_mind_map_proposal_route,
)
from pkg.models.application.mind_map import (
    MindMap,
    MindMapNode,
    MindMapNodeReference,
    MindMapRevision,
)
from pkg.schemas.application.mind_map import (
    AssetOutlineRefreshApply,
    AssetOutlinePatchProposalRead,
    AssetOutlineRefreshProposalRead,
    MindMapCreate,
    MindMapDelete,
    MindMapNodeCreate,
    MindMapOutlineApply,
    MindMapReferenceCreate,
    MindMapRevisionRestore,
    MindMapUpdate,
    SourceMindMapGenerationContextRead,
    SourceMindMapProposalApply,
    SourceMindMapProposalValidate,
)
from pkg.services.application.mind_maps import (
    MindMapMutationState,
    MindMapStalenessState,
    MindMapTreeState,
    SourceMindMapProposalValidationState,
)


NOW = datetime(2026, 9, 9, tzinfo=UTC)


def make_map(*, version: int = 3) -> MindMap:
    return MindMap(
        id="map-1",
        user_id="user-1",
        title="Document map",
        owner_type="source",
        owner_id="source-1",
        purpose="document_overview",
        layout_mode="balanced",
        version=version,
        basis_revision={},
        generation_status="manual",
        created_at=NOW,
        updated_at=NOW,
    )


def make_node() -> MindMapNode:
    return MindMapNode(
        id="root",
        map_id="map-1",
        display_id=1,
        parent_id=None,
        content="Document map",
        note=None,
        position=0,
        collapsed=False,
        node_kind="topic",
        updated_by="human",
        created_at=NOW,
        updated_at=NOW,
    )


def make_revision(*, version: int = 4) -> MindMapRevision:
    mind_map = make_map(version=version)
    root = make_node()
    return MindMapRevision(
        id=f"revision-{version}",
        map_id=mind_map.id,
        version=version,
        actor_type="human",
        actor_ref=None,
        action="map_updated",
        summary="Updated Mind Map settings",
        snapshot={
            "map": {
                "id": mind_map.id,
                "user_id": mind_map.user_id,
                "owner_type": mind_map.owner_type,
                "owner_id": mind_map.owner_id,
                "purpose": mind_map.purpose,
                "title": mind_map.title,
                "root_node_id": root.id,
                "layout_mode": mind_map.layout_mode,
                "version": version,
                "basis_revision": {},
                "generation_status": mind_map.generation_status,
                "created_at": NOW.isoformat(),
                "updated_at": NOW.isoformat(),
            },
            "nodes": [
                {
                    "id": root.id,
                    "map_id": root.map_id,
                    "display_id": root.display_id,
                    "parent_id": root.parent_id,
                    "content": root.content,
                    "note": root.note,
                    "position": root.position,
                    "collapsed": root.collapsed,
                    "node_kind": root.node_kind,
                    "updated_by": root.updated_by,
                    "created_at": NOW.isoformat(),
                    "updated_at": NOW.isoformat(),
                }
            ],
            "references": [],
        },
        created_at=NOW,
    )


def make_reference() -> MindMapNodeReference:
    return MindMapNodeReference(
        id="reference-1",
        map_id="map-1",
        node_id="root",
        ref_type="source",
        ref_id="source-1",
        relation="derived_from",
        fragment_selector=None,
        created_at=NOW,
    )


def make_user():
    user = MagicMock()
    user.id = "user-1"
    return user


def test_core_mind_map_routes_are_registered() -> None:
    methods_by_path: dict[str, set[str]] = {}
    for route in app.routes:
        methods_by_path.setdefault(route.path, set()).update(getattr(route, "methods", set()))

    assert {"GET", "POST"} <= methods_by_path["/mind-maps"]
    assert {"GET", "PATCH", "DELETE"} <= methods_by_path["/mind-maps/{map_id}"]
    assert "GET" in methods_by_path["/mind-maps/{map_id}/tree"]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/check-staleness"]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/check-asset-outline-staleness"]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/proposals/asset-outline/refresh"]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/proposals/asset-outline/refresh/apply"]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/proposals/asset-outline/document-patch"]
    assert "POST" in methods_by_path["/mind-maps/projections/asset-outline"]
    assert "POST" in methods_by_path["/mind-maps/proposals/source/validate"]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/nodes"]
    assert {"PATCH", "DELETE"} <= methods_by_path[
        "/mind-maps/{map_id}/nodes/{node_id}"
    ]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/nodes/{node_id}/move"]
    assert "GET" in methods_by_path["/mind-maps/references"]
    assert "POST" in methods_by_path[
        "/mind-maps/{map_id}/nodes/{node_id}/references"
    ]
    assert "POST" in methods_by_path["/mind-maps/{map_id}/outline/apply"]
    assert {"PATCH", "DELETE"} <= methods_by_path[
        "/mind-maps/{map_id}/nodes/{node_id}/references/{reference_id}"
    ]
    assert "GET" in methods_by_path["/mind-maps/{map_id}/revisions"]
    assert "GET" in methods_by_path["/mind-maps/{map_id}/revisions/{version}"]
    assert "POST" in methods_by_path[
        "/mind-maps/{map_id}/revisions/{version}/restore"
    ]


def test_openapi_documents_version_conflict_contract() -> None:
    schema = app.openapi()
    conflict_schema = schema["paths"]["/mind-maps/{map_id}"]["patch"]["responses"][
        "409"
    ]["content"]["application/json"]["schema"]

    assert conflict_schema == {
        "$ref": "#/components/schemas/MindMapVersionConflictResponse"
    }
    assert "MindMapTreeRead" in schema["components"]["schemas"]
    assert "MindMapRevisionRestore" in schema["components"]["schemas"]
    assert "MindMapReferenceList" in schema["components"]["schemas"]
    assert "MindMapOutlineApplyResult" in schema["components"]["schemas"]
    assert "MindMapStalenessRead" in schema["components"]["schemas"]
    assert "SourceMindMapProposalValidationRead" in schema["components"]["schemas"]


@pytest.mark.asyncio
async def test_source_proposal_validation_route_returns_read_only_preview_contract() -> None:
    body = SourceMindMapProposalValidate(
        source_id="source-1",
        basis_revision={
            "source_content_hash": "hash-1",
            "chunk_count": 2,
            "chunk_revision": 3,
        },
        proposal={
            "title": "Document overview",
            "nodes": [
                {
                    "temp_id": "root",
                    "parent_temp_id": None,
                    "position": 0,
                    "content": "Document overview",
                    "node_kind": "topic",
                }
            ],
        },
    )
    result = SourceMindMapProposalValidationState(
        source_id="source-1",
        basis_revision=body.basis_revision.model_dump(),
        proposal=body.proposal,
        node_count=1,
        reference_count=0,
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.validate_source_mind_map_proposal",
        new=AsyncMock(return_value=result),
    ) as mock:
        response = await validate_source_mind_map_proposal_route(
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.source_id == "source-1"
    assert response.node_count == 1
    assert response.reference_count == 0
    assert response.proposal.nodes[0].temp_id == "root"
    mock.assert_awaited_once_with(session, user_id="user-1", body=body)


@pytest.mark.asyncio
async def test_source_generation_context_route_returns_bounded_contract() -> None:
    context = SourceMindMapGenerationContextRead(
        source_id="source-1",
        source_metadata={
            "title": "Document",
            "source_type": "pdf",
            "ingested_at": NOW,
        },
        basis_revision={
            "source_content_hash": "hash-1",
            "chunk_count": 1,
            "chunk_revision": 2,
        },
        sampling={
            "strategy": "all_chunks",
            "total_chunk_count": 1,
            "sampled_chunk_count": 1,
            "omitted_chunk_count": 0,
            "coverage_percent": 100,
            "max_sampled_chunks": 80,
            "section_count": 1,
        },
        input_summary={
            "section_summaries": [],
            "chunk_summaries": [
                {"chunk_id": 11, "chunk_index": 0, "summary": "Bounded summary"}
            ],
        },
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.build_source_mind_map_generation_context",
        new=AsyncMock(return_value=context),
    ) as mock:
        response = await get_source_mind_map_generation_context_route(
            source_id="source-1",
            user=make_user(),
            session=session,
        )

    assert response == context
    mock.assert_awaited_once_with(session, user_id="user-1", source_id="source-1")


@pytest.mark.asyncio
async def test_source_proposal_apply_route_returns_persisted_tree() -> None:
    body = SourceMindMapProposalApply(
        source_id="source-1",
        basis_revision={"source_content_hash": "hash-1", "chunk_count": 1, "chunk_revision": None},
        proposal={
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
        confirm=True,
    )
    mind_map = make_map(version=1)
    root = make_node()
    tree = MindMapTreeState(map=mind_map, root_id=root.id, nodes=[root], references=[])
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.apply_source_mind_map_proposal",
        new=AsyncMock(return_value=tree),
    ) as mock:
        response = await apply_source_mind_map_proposal_route(
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.root_id == "root"
    mock.assert_awaited_once_with(session, user_id="user-1", body=body)


@pytest.mark.asyncio
async def test_staleness_route_returns_map_basis_and_reasons() -> None:
    mind_map = make_map(version=3)
    mind_map.generation_status = "stale"
    result = MindMapStalenessState(
        map=mind_map,
        root_id="root",
        stale=True,
        reasons=("source_content_hash", "chunk_count"),
        current_basis={
            "source_content_hash": "hash-2",
            "chunk_count": 4,
            "chunk_revision": 3,
        },
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.check_source_mind_map_staleness",
        new=AsyncMock(return_value=result),
    ) as mock:
        response = await check_mind_map_staleness_route(
            map_id="map-1",
            user=make_user(),
            session=session,
        )

    assert response.map.root_node_id == "root"
    assert response.map.version == 3
    assert response.stale is True
    assert response.reasons == ["source_content_hash", "chunk_count"]
    assert response.current_basis["chunk_revision"] == 3
    mock.assert_awaited_once_with(session, user_id="user-1", map_id="map-1")


@pytest.mark.asyncio
async def test_asset_outline_staleness_route_returns_current_basis() -> None:
    mind_map = make_map(version=5)
    mind_map.owner_type = "asset"
    mind_map.owner_id = "asset-1"
    mind_map.purpose = "asset_outline"
    mind_map.generation_status = "stale"
    result = MindMapStalenessState(
        map=mind_map,
        root_id="root",
        stale=True,
        reasons=("asset_document_revision", "base_document_signature"),
        current_basis={
            "workspace_revision": 4,
            "intent_revision": 2,
            "asset_document_revision": 6,
            "base_document_signature": "document-current",
            "accepted_claim_ids": ["claim-1"],
        },
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.check_asset_outline_staleness",
        new=AsyncMock(return_value=result),
    ) as mock:
        response = await check_asset_outline_staleness_route(
            map_id="map-1",
            user=make_user(),
            session=session,
        )

    assert response.map.version == 5
    assert response.stale is True
    assert response.reasons == ["asset_document_revision", "base_document_signature"]
    assert response.current_basis.asset_document_revision == 6
    mock.assert_awaited_once_with(session, user_id="user-1", map_id="map-1")


@pytest.mark.asyncio
async def test_asset_outline_refresh_route_returns_preview_without_applying() -> None:
    result = AssetOutlineRefreshProposalRead.model_validate({
        "map_id": "map-1",
        "base_version": 5,
        "proposal": {
            "asset_id": "asset-1",
            "title": "Architecture Brief · Outline",
            "basis_revision": {
                "workspace_revision": 4,
                "intent_revision": 2,
                "asset_document_revision": 6,
                "base_document_signature": "document-current",
                "accepted_claim_ids": ["claim-1"],
            },
            "nodes": [
                {
                    "temp_id": "root",
                    "parent_temp_id": None,
                    "position": 0,
                    "content": "Architecture Brief",
                    "node_kind": "topic",
                },
                {
                    "temp_id": "block-1",
                    "parent_temp_id": "root",
                    "position": 0,
                    "content": "Updated Executive Summary",
                    "node_kind": "section",
                    "asset_block_id": "block-1",
                    "claim_refs": ["claim-1"],
                },
            ],
        },
        "node_count": 2,
        "reference_count": 2,
    })
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.build_asset_outline_refresh_proposal",
        new=AsyncMock(return_value=result),
    ) as mock:
        response = await build_asset_outline_refresh_proposal_route(
            map_id="map-1",
            user=make_user(),
            session=session,
        )

    assert response is result
    assert response.base_version == 5
    assert response.proposal.requires_user_confirmation is True
    assert response.proposal.writes_asset is False
    mock.assert_awaited_once_with(session, user_id="user-1", map_id="map-1")


@pytest.mark.asyncio
async def test_asset_outline_refresh_apply_route_delegates_confirmed_proposal() -> None:
    body = AssetOutlineRefreshApply.model_validate({
        "base_version": 5,
        "confirm": True,
        "proposal": {
            "asset_id": "asset-1",
            "title": "Architecture Brief · Outline",
            "basis_revision": {
                "workspace_revision": 4,
                "intent_revision": 2,
                "asset_document_revision": 6,
                "base_document_signature": "document-current",
                "accepted_claim_ids": ["claim-1"],
            },
            "nodes": [
                {
                    "temp_id": "root",
                    "parent_temp_id": None,
                    "position": 0,
                    "content": "Architecture Brief",
                    "node_kind": "topic",
                },
                {
                    "temp_id": "block-1",
                    "parent_temp_id": "root",
                    "position": 0,
                    "content": "Updated Executive Summary",
                    "node_kind": "section",
                    "asset_block_id": "block-1",
                    "claim_refs": ["claim-1"],
                },
            ],
        },
    })
    mind_map = make_map(version=6)
    mind_map.owner_type = "asset"
    mind_map.owner_id = "asset-1"
    mind_map.purpose = "asset_outline"
    root = make_node()
    root.content = "Architecture Brief"
    tree = MindMapTreeState(map=mind_map, root_id=root.id, nodes=[root], references=[])
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.apply_asset_outline_refresh_proposal",
        new=AsyncMock(return_value=tree),
    ) as mock:
        response = await apply_asset_outline_refresh_proposal_route(
            map_id="map-1",
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.map.version == 6
    assert response.root_id == "root"
    mock.assert_awaited_once_with(
        session,
        user_id="user-1",
        map_id="map-1",
        body=body,
    )


@pytest.mark.asyncio
async def test_asset_outline_document_patch_route_returns_read_only_proposal() -> None:
    result = AssetOutlinePatchProposalRead.model_validate({
        "map_id": "map-1",
        "base_map_version": 6,
        "basis_revision": {
            "workspace_revision": 4,
            "intent_revision": 2,
            "asset_document_revision": 6,
            "base_document_signature": "document-current",
            "accepted_claim_ids": ["claim-1"],
        },
        "patch": {
            "asset_id": "asset-1",
            "map_id": "map-1",
            "base_map_version": 6,
            "basis_revision": {
                "workspace_revision": 4,
                "intent_revision": 2,
                "asset_document_revision": 6,
                "base_document_signature": "document-current",
                "accepted_claim_ids": ["claim-1"],
            },
            "operations": [
                {"operation": "rename", "block_id": "block-1", "base_block_revision": 1, "replacement_markdown": "## Updated Summary"},
            ],
            "requires_user_confirmation": True,
            "writes_asset": False,
        },
        "operation_counts": {"add": 0, "move": 0, "rename": 1, "delete": 0},
        "warnings": [],
        "no_changes": False,
    })
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.build_asset_outline_document_patch",
        new=AsyncMock(return_value=result),
    ) as mock:
        response = await build_asset_outline_document_patch_route(
            map_id="map-1",
            user=make_user(),
            session=session,
        )

    assert response.patch is not None
    assert response.patch.writes_asset is False
    mock.assert_awaited_once_with(session, user_id="user-1", map_id="map-1")


@pytest.mark.asyncio
async def test_create_route_delegates_and_assembles_tree_response() -> None:
    mind_map = make_map(version=1)
    root = make_node()
    tree = MindMapTreeState(map=mind_map, root_id=root.id, nodes=[root], references=[])
    body = MindMapCreate(
        owner_type="source",
        owner_id="source-1",
        purpose="document_overview",
        title="Document map",
    )
    session = AsyncMock()

    with patch("pkg.api.mind_maps.create_mind_map", new=AsyncMock(return_value=tree)) as mock:
        response = await create_mind_map_route(body=body, user=make_user(), session=session)

    assert response.map.id == "map-1"
    assert response.root_id == "root"
    assert response.nodes[0].content == "Document map"
    mock.assert_awaited_once_with(session, user_id="user-1", body=body)


@pytest.mark.asyncio
async def test_map_update_route_assembles_mutation_response() -> None:
    mind_map = make_map(version=4)
    mutation = MindMapMutationState(
        map=mind_map,
        root_id="root",
        previous_version=3,
        current_version=4,
        revision=make_revision(version=4),
    )
    body = MindMapUpdate(base_version=3, title="Updated map")
    session = AsyncMock()

    with patch("pkg.api.mind_maps.update_mind_map", new=AsyncMock(return_value=mutation)):
        response = await update_mind_map_route(
            map_id="map-1",
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.map_id == "map-1"
    assert response.previous_version == 3
    assert response.current_version == 4
    assert response.revision.version == 4


@pytest.mark.asyncio
async def test_node_add_route_passes_user_and_versioned_body() -> None:
    mind_map = make_map(version=4)
    node = make_node()
    mutation = MindMapMutationState(
        map=mind_map,
        root_id="root",
        previous_version=3,
        current_version=4,
        revision=make_revision(version=4),
        node=node,
    )
    body = MindMapNodeCreate(base_version=3, parent_id="root", content="Child")
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.add_mind_map_node",
        new=AsyncMock(return_value=mutation),
    ) as mock:
        response = await add_mind_map_node_route(
            map_id="map-1",
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.node is not None
    assert response.node.id == "root"
    mock.assert_awaited_once_with(
        session,
        user_id="user-1",
        map_id="map-1",
        body=body,
    )


@pytest.mark.asyncio
async def test_reference_create_route_assembles_reference_response() -> None:
    mind_map = make_map(version=4)
    reference = make_reference()
    mutation = MindMapMutationState(
        map=mind_map,
        root_id="root",
        previous_version=3,
        current_version=4,
        revision=make_revision(version=4),
        reference=reference,
    )
    body = MindMapReferenceCreate(
        base_version=3,
        ref_type="source",
        ref_id="source-1",
        relation="derived_from",
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.create_mind_map_reference",
        new=AsyncMock(return_value=mutation),
    ) as mock:
        response = await create_mind_map_reference_route(
            map_id="map-1",
            node_id="root",
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.reference is not None
    assert response.reference.id == "reference-1"
    mock.assert_awaited_once_with(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id="root",
        body=body,
    )


@pytest.mark.asyncio
async def test_outline_apply_route_assembles_change_counts() -> None:
    mind_map = make_map(version=4)
    mutation = MindMapMutationState(
        map=mind_map,
        root_id="root",
        previous_version=3,
        current_version=4,
        revision=make_revision(version=4),
        outline_mode="merge",
        created_count=2,
        updated_count=1,
        moved_count=1,
        deleted_count=0,
    )
    body = MindMapOutlineApply(
        base_version=3,
        outline="- [id:1] Root\n  - New branch",
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.apply_mind_map_outline",
        new=AsyncMock(return_value=mutation),
    ) as mock:
        response = await apply_mind_map_outline_route(
            map_id="map-1",
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.mode == "merge"
    assert response.created_count == 2
    assert response.updated_count == 1
    assert response.moved_count == 1
    mock.assert_awaited_once_with(
        session,
        user_id="user-1",
        map_id="map-1",
        body=body,
    )


@pytest.mark.asyncio
async def test_restore_route_passes_target_version_and_assembles_response() -> None:
    mind_map = make_map(version=6)
    mutation = MindMapMutationState(
        map=mind_map,
        root_id="root",
        previous_version=5,
        current_version=6,
        revision=make_revision(version=6),
    )
    body = MindMapRevisionRestore(base_version=5, confirm=True)
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.restore_mind_map_revision",
        new=AsyncMock(return_value=mutation),
    ) as mock:
        response = await restore_mind_map_revision_route(
            map_id="map-1",
            version=2,
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.current_version == 6
    mock.assert_awaited_once_with(
        session,
        user_id="user-1",
        map_id="map-1",
        version=2,
        body=body,
    )


@pytest.mark.asyncio
async def test_delete_map_route_returns_204() -> None:
    body = MindMapDelete(base_version=3, confirm=True)
    session = AsyncMock()

    with patch("pkg.api.mind_maps.delete_mind_map", new=AsyncMock()) as mock:
        response = await delete_mind_map_route(
            map_id="map-1",
            body=body,
            user=make_user(),
            session=session,
        )

    assert response.status_code == 204
    mock.assert_awaited_once_with(
        session,
        user_id="user-1",
        map_id="map-1",
        body=body,
    )


@pytest.mark.asyncio
async def test_route_preserves_structured_version_conflict() -> None:
    conflict = HTTPException(
        status_code=409,
        detail={
            "code": "mind_map_version_conflict",
            "message": "Mind Map version changed: expected 3, current 4",
            "map_id": "map-1",
            "expected_version": 3,
            "current_version": 4,
        },
    )
    session = AsyncMock()

    with patch(
        "pkg.api.mind_maps.update_mind_map",
        new=AsyncMock(side_effect=conflict),
    ):
        with pytest.raises(HTTPException) as exc:
            await update_mind_map_route(
                map_id="map-1",
                body=MindMapUpdate(base_version=3, title="Stale"),
                user=make_user(),
                session=session,
            )

    assert exc.value.detail["code"] == "mind_map_version_conflict"
