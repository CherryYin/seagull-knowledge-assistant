from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.api.app import app
from pkg.api.mind_maps import (
    add_mind_map_node_route,
    apply_mind_map_outline_route,
    create_mind_map_reference_route,
    create_mind_map_route,
    delete_mind_map_route,
    restore_mind_map_revision_route,
    update_mind_map_route,
)
from pkg.models.application.mind_map import (
    MindMap,
    MindMapNode,
    MindMapNodeReference,
    MindMapRevision,
)
from pkg.schemas.application.mind_map import (
    MindMapCreate,
    MindMapDelete,
    MindMapNodeCreate,
    MindMapOutlineApply,
    MindMapReferenceCreate,
    MindMapRevisionRestore,
    MindMapUpdate,
)
from pkg.services.application.mind_maps import MindMapMutationState, MindMapTreeState


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
