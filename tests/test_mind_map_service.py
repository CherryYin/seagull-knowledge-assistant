from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

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
    MindMapNodeDelete,
    MindMapNodeMove,
    MindMapNodeUpdate,
    MindMapOutlineApply,
    MindMapReferenceCreate,
    MindMapReferenceDelete,
    MindMapReferenceUpdate,
    MindMapRevisionRestore,
    MindMapUpdate,
)
from pkg.services.application.mind_maps import (
    _validate_reference_target,
    add_mind_map_node,
    apply_mind_map_outline,
    create_mind_map_reference,
    create_mind_map,
    delete_mind_map,
    delete_mind_map_node,
    delete_mind_map_reference,
    get_mind_map_revision,
    get_mind_map_summary,
    get_mind_map_tree,
    list_mind_map_revisions,
    list_mind_map_references_by_target,
    list_mind_maps,
    move_mind_map_node,
    parse_mind_map_outline,
    restore_mind_map_revision,
    update_mind_map,
    update_mind_map_reference,
    update_mind_map_node,
)


NOW = datetime(2026, 9, 8, tzinfo=UTC)


class QueryResult:
    def __init__(self, *, scalar=None, items=None, rows=None):
        self.scalar = scalar
        self.items = list(items or [])
        self.rows = list(rows or [])

    def scalar_one_or_none(self):
        return self.scalar

    def scalar_one(self):
        return self.scalar

    def scalars(self):
        return self

    def all(self):
        return self.items or self.rows


def make_session(*results: QueryResult):
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=results)
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.delete = AsyncMock()
    session.flush = AsyncMock()
    return session


def make_map(*, version: int = 3, user_id: str = "user-1") -> MindMap:
    return MindMap(
        id="map-1",
        user_id=user_id,
        title="Distributed systems",
        owner_type="source",
        owner_id="source-1",
        purpose="document_overview",
        layout_mode="balanced",
        version=version,
        basis_revision={"chunk_revision": 2},
        generation_status="ready",
        created_at=NOW,
        updated_at=NOW,
    )


def make_node(
    node_id: str,
    display_id: int,
    parent_id: str | None,
    position: int,
) -> MindMapNode:
    return MindMapNode(
        id=node_id,
        map_id="map-1",
        display_id=display_id,
        parent_id=parent_id,
        content=node_id,
        note=None,
        position=position,
        collapsed=False,
        node_kind="topic",
        updated_by="human",
        created_at=NOW,
        updated_at=NOW,
    )


def make_reference(node_id: str) -> MindMapNodeReference:
    return MindMapNodeReference(
        id=f"reference-{node_id}",
        map_id="map-1",
        node_id=node_id,
        ref_type="source_chunk",
        ref_id=f"chunk-{node_id}",
        relation="derived_from",
        fragment_selector=None,
        created_at=NOW,
    )


def make_revision(
    *,
    version: int,
    mind_map: MindMap,
    nodes: list[MindMapNode],
    references: list[MindMapNodeReference] | None = None,
    snapshot_user_id: str | None = None,
) -> MindMapRevision:
    root = next(node for node in nodes if node.parent_id is None)
    snapshot = {
        "map": {
            "id": mind_map.id,
            "user_id": snapshot_user_id or mind_map.user_id,
            "owner_type": mind_map.owner_type,
            "owner_id": mind_map.owner_id,
            "purpose": mind_map.purpose,
            "title": mind_map.title,
            "root_node_id": root.id,
            "layout_mode": mind_map.layout_mode,
            "version": version,
            "basis_revision": mind_map.basis_revision,
            "generation_status": mind_map.generation_status,
            "created_at": NOW.isoformat(),
            "updated_at": NOW.isoformat(),
        },
        "nodes": [
            {
                "id": node.id,
                "map_id": node.map_id,
                "display_id": node.display_id,
                "parent_id": node.parent_id,
                "content": node.content,
                "note": node.note,
                "position": node.position,
                "collapsed": node.collapsed,
                "node_kind": node.node_kind,
                "updated_by": node.updated_by,
                "created_at": NOW.isoformat(),
                "updated_at": NOW.isoformat(),
            }
            for node in nodes
        ],
        "references": [
            {
                "id": reference.id,
                "map_id": reference.map_id,
                "node_id": reference.node_id,
                "ref_type": reference.ref_type,
                "ref_id": reference.ref_id,
                "relation": reference.relation,
                "fragment_selector": reference.fragment_selector,
                "created_at": NOW.isoformat(),
            }
            for reference in references or []
        ],
    }
    return MindMapRevision(
        id=f"revision-{version}",
        map_id=mind_map.id,
        version=version,
        actor_type="human",
        actor_ref=None,
        action="node_updated",
        summary=f"Version {version}",
        snapshot=snapshot,
        created_at=NOW,
    )


@pytest.mark.asyncio
async def test_create_map_adds_root_and_initial_revision_in_one_commit() -> None:
    session = make_session(
        QueryResult(scalar="source-1"),
        QueryResult(scalar=None),
    )

    tree = await create_mind_map(
        session,
        user_id="user-1",
        body=MindMapCreate(
            owner_type="source",
            owner_id="source-1",
            purpose="document_overview",
            title="Document map",
        ),
    )

    added = [call.args[0] for call in session.add.call_args_list]
    mind_map, root, revision = added
    assert tree.map is mind_map
    assert tree.nodes == [root]
    assert root.parent_id is None
    assert root.display_id == 1
    assert root.content == "Document map"
    assert revision.version == 1
    assert revision.action == "map_created"
    assert revision.snapshot["map"]["root_node_id"] == root.id
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_map_rejects_owner_from_another_user() -> None:
    session = make_session(QueryResult(scalar=None))

    with pytest.raises(HTTPException) as exc:
        await create_mind_map(
            session,
            user_id="user-1",
            body=MindMapCreate(
                owner_type="source",
                owner_id="source-other-user",
                purpose="document_overview",
                title="Private source map",
            ),
        )

    assert exc.value.status_code == 404
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_tree_returns_flat_nodes_and_references() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    child = make_node("child", 2, root.id, 0)
    reference = make_reference(child.id)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, child]),
        QueryResult(items=[reference]),
    )

    tree = await get_mind_map_tree(session, user_id="user-1", map_id="map-1")

    assert tree.root_id == "root"
    assert tree.nodes == [root, child]
    assert tree.references == [reference]


@pytest.mark.asyncio
async def test_get_tree_hides_maps_owned_by_another_user() -> None:
    session = make_session(QueryResult(scalar=None))

    with pytest.raises(HTTPException) as exc:
        await get_mind_map_tree(session, user_id="user-1", map_id="private-map")

    assert exc.value.status_code == 404
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_maps_returns_root_ids_and_total_for_current_user() -> None:
    first = make_map()
    second = make_map()
    second.id = "map-2"
    session = make_session(
        QueryResult(items=[first, second]),
        QueryResult(scalar=2),
        QueryResult(rows=[("map-1", "root-1"), ("map-2", "root-2")]),
    )

    summaries, total = await list_mind_maps(session, user_id="user-1")

    assert total == 2
    assert [(item.map.id, item.root_id) for item in summaries] == [
        ("map-1", "root-1"),
        ("map-2", "root-2"),
    ]


@pytest.mark.asyncio
async def test_get_map_summary_returns_exactly_one_root() -> None:
    mind_map = make_map()
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=["root"]),
    )

    summary = await get_mind_map_summary(session, user_id="user-1", map_id="map-1")

    assert summary.map is mind_map
    assert summary.root_id == "root"


@pytest.mark.asyncio
async def test_update_map_records_title_and_layout_revision() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
        QueryResult(items=[]),
    )

    result = await update_mind_map(
        session,
        user_id="user-1",
        map_id="map-1",
        body=MindMapUpdate(base_version=3, title="Updated Map", layout_mode="right"),
    )

    assert mind_map.title == "Updated Map"
    assert mind_map.layout_mode == "right"
    assert result.previous_version == 3
    assert result.current_version == 4
    assert result.revision.action == "map_updated"
    assert result.revision.snapshot["map"]["title"] == "Updated Map"


@pytest.mark.asyncio
async def test_delete_map_requires_current_version_and_deletes_owned_map() -> None:
    mind_map = make_map()
    session = make_session(QueryResult(scalar=mind_map))

    await delete_mind_map(
        session,
        user_id="user-1",
        map_id="map-1",
        body=MindMapDelete(base_version=3, confirm=True),
    )

    session.delete.assert_awaited_once_with(mind_map)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_tree_rejects_a_cycle_in_persisted_data() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    first = make_node("first", 2, "second", 0)
    second = make_node("second", 3, "first", 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, first, second]),
    )

    with pytest.raises(HTTPException) as exc:
        await get_mind_map_tree(session, user_id="user-1", map_id="map-1")

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "mind_map_invalid_tree"
    assert "Cycle detected" in exc.value.detail["message"]


@pytest.mark.asyncio
async def test_add_node_inserts_at_requested_position_and_records_revision() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    first = make_node("first", 2, root.id, 0)
    second = make_node("second", 3, root.id, 1)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, first, second]),
        QueryResult(items=[]),
    )

    result = await add_mind_map_node(
        session,
        user_id="user-1",
        map_id="map-1",
        body=MindMapNodeCreate(
            base_version=3,
            parent_id=root.id,
            content="Inserted",
            position=1,
        ),
    )

    assert result.previous_version == 3
    assert result.current_version == 4
    assert result.node is not None
    assert result.node.display_id == 4
    assert result.node.position == 1
    assert first.position == 0
    assert second.position == 2
    assert result.revision.action == "node_added"
    assert result.revision.snapshot["map"]["version"] == 4
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_stale_base_version_returns_structured_conflict() -> None:
    mind_map = make_map(version=5)
    session = make_session(QueryResult(scalar=mind_map))

    with pytest.raises(HTTPException) as exc:
        await update_mind_map_node(
            session,
            user_id="user-1",
            map_id="map-1",
            node_id="root",
            body=MindMapNodeUpdate(base_version=4, content="Stale update"),
        )

    assert exc.value.status_code == 409
    assert exc.value.detail == {
        "code": "mind_map_version_conflict",
        "message": "Mind Map version changed: expected 4, current 5",
        "map_id": "map-1",
        "expected_version": 4,
        "current_version": 5,
    }
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_node_changes_content_once_and_records_revision() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
        QueryResult(items=[]),
    )

    result = await update_mind_map_node(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id=root.id,
        body=MindMapNodeUpdate(base_version=3, content="Updated root", updated_by="agent"),
        actor_ref="session-1",
    )

    assert root.content == "Updated root"
    assert root.updated_by == "agent"
    assert result.current_version == 4
    assert result.revision.actor_type == "agent"
    assert result.revision.actor_ref == "session-1"
    assert result.revision.action == "node_updated"


@pytest.mark.asyncio
async def test_move_node_rejects_cycle_without_committing() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    parent = make_node("parent", 2, root.id, 0)
    child = make_node("child", 3, parent.id, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, parent, child]),
    )

    with pytest.raises(HTTPException, match="own subtree"):
        await move_mind_map_node(
            session,
            user_id="user-1",
            map_id="map-1",
            node_id=parent.id,
            body=MindMapNodeMove(base_version=3, parent_id=child.id, position=0),
        )

    assert mind_map.version == 3
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_move_node_reparents_and_compacts_both_sibling_groups() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    branch_a = make_node("branch-a", 2, root.id, 0)
    branch_b = make_node("branch-b", 3, root.id, 1)
    moving = make_node("moving", 4, branch_a.id, 0)
    remaining = make_node("remaining", 5, branch_a.id, 1)
    existing_target = make_node("existing-target", 6, branch_b.id, 0)
    nodes = [root, branch_a, branch_b, moving, remaining, existing_target]
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=nodes),
        QueryResult(items=[]),
    )

    result = await move_mind_map_node(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id=moving.id,
        body=MindMapNodeMove(base_version=3, parent_id=branch_b.id, position=0),
    )

    assert moving.parent_id == branch_b.id
    assert moving.position == 0
    assert existing_target.position == 1
    assert remaining.position == 0
    assert result.revision.action == "node_moved"
    assert result.current_version == 4


@pytest.mark.asyncio
async def test_delete_node_removes_subtree_and_compacts_siblings() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    deleted = make_node("deleted", 2, root.id, 0)
    descendant = make_node("descendant", 3, deleted.id, 0)
    remaining = make_node("remaining", 4, root.id, 1)
    deleted_reference = make_reference(descendant.id)
    remaining_reference = make_reference(remaining.id)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, deleted, descendant, remaining]),
        QueryResult(),
        QueryResult(items=[deleted_reference, remaining_reference]),
    )

    result = await delete_mind_map_node(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id=deleted.id,
        body=MindMapNodeDelete(base_version=3),
    )

    assert result.deleted_node_ids == ("deleted", "descendant")
    assert remaining.position == 0
    snapshot_node_ids = {node["id"] for node in result.revision.snapshot["nodes"]}
    snapshot_reference_ids = {
        reference["id"] for reference in result.revision.snapshot["references"]
    }
    assert snapshot_node_ids == {"root", "remaining"}
    assert snapshot_reference_ids == {remaining_reference.id}
    assert result.current_version == 4


@pytest.mark.asyncio
async def test_delete_root_requires_deleting_the_map_instead() -> None:
    mind_map = make_map()
    root = make_node("root", 1, None, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
    )

    with pytest.raises(HTTPException, match="delete the Map"):
        await delete_mind_map_node(
            session,
            user_id="user-1",
            map_id="map-1",
            node_id=root.id,
            body=MindMapNodeDelete(base_version=3),
        )

    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_revisions_returns_newest_first_result_and_total() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    newest = make_revision(version=3, mind_map=mind_map, nodes=[root])
    older = make_revision(version=2, mind_map=mind_map, nodes=[root])
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[newest, older]),
        QueryResult(scalar=2),
    )

    revisions, total = await list_mind_map_revisions(
        session,
        user_id="user-1",
        map_id="map-1",
    )

    assert revisions == [newest, older]
    assert total == 2


@pytest.mark.asyncio
async def test_get_revision_is_scoped_to_user_owned_map() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    revision = make_revision(version=2, mind_map=mind_map, nodes=[root])
    session = make_session(QueryResult(scalar=mind_map), QueryResult(scalar=revision))

    result = await get_mind_map_revision(
        session,
        user_id="user-1",
        map_id="map-1",
        version=2,
    )

    assert result is revision


@pytest.mark.asyncio
async def test_restore_revision_rebuilds_tree_and_advances_from_current_version() -> None:
    current_map = make_map(version=5)
    current_map.title = "Current title"
    current_root = make_node("current-root", 1, None, 0)
    current_child = make_node("current-child", 2, current_root.id, 0)

    historical_map = make_map(version=2)
    historical_map.title = "Historical title"
    historical_map.layout_mode = "right"
    historical_root = make_node("historical-root", 1, None, 0)
    historical_child = make_node("historical-child", 2, historical_root.id, 0)
    historical_reference = make_reference(historical_child.id)
    target = make_revision(
        version=2,
        mind_map=historical_map,
        nodes=[historical_root, historical_child],
        references=[historical_reference],
    )
    session = make_session(
        QueryResult(scalar=current_map),
        QueryResult(scalar=target),
        QueryResult(items=[current_root, current_child]),
        QueryResult(),
    )

    result = await restore_mind_map_revision(
        session,
        user_id="user-1",
        map_id="map-1",
        version=2,
        body=MindMapRevisionRestore(base_version=5, confirm=True),
        actor_ref="session-restore",
    )

    assert result.previous_version == 5
    assert result.current_version == 6
    assert result.root_id == "historical-root"
    assert result.deleted_node_ids == ("current-child", "current-root")
    assert current_map.title == "Historical title"
    assert current_map.layout_mode == "right"
    assert result.revision.version == 6
    assert result.revision.action == "restored"
    assert result.revision.actor_ref == "session-restore"
    assert result.revision.snapshot["map"]["version"] == 6
    assert {node["id"] for node in result.revision.snapshot["nodes"]} == {
        "historical-root",
        "historical-child",
    }
    assert result.revision.snapshot["references"][0]["id"] == historical_reference.id
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_restore_rejects_snapshot_that_changes_map_identity() -> None:
    current_map = make_map(version=5)
    root = make_node("root", 1, None, 0)
    target = make_revision(
        version=2,
        mind_map=make_map(version=2),
        nodes=[root],
        snapshot_user_id="another-user",
    )
    session = make_session(QueryResult(scalar=current_map), QueryResult(scalar=target))

    with pytest.raises(HTTPException) as exc:
        await restore_mind_map_revision(
            session,
            user_id="user-1",
            map_id="map-1",
            version=2,
            body=MindMapRevisionRestore(base_version=5, confirm=True),
        )

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "mind_map_invalid_tree"
    assert "user_id" in exc.value.detail["message"]
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_restore_rejects_current_revision_as_a_noop() -> None:
    current_map = make_map(version=5)
    root = make_node("root", 1, None, 0)
    target = make_revision(version=5, mind_map=current_map, nodes=[root])
    session = make_session(QueryResult(scalar=current_map), QueryResult(scalar=target))

    with pytest.raises(HTTPException, match="historical"):
        await restore_mind_map_revision(
            session,
            user_id="user-1",
            map_id="map-1",
            version=5,
            body=MindMapRevisionRestore(base_version=5, confirm=True),
        )

    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_restore_can_repair_an_invalid_current_tree() -> None:
    current_map = make_map(version=5)
    invalid_first = make_node("invalid-first", 1, "invalid-second", 0)
    invalid_second = make_node("invalid-second", 2, "invalid-first", 0)
    historical_map = make_map(version=2)
    historical_root = make_node("historical-root", 1, None, 0)
    target = make_revision(version=2, mind_map=historical_map, nodes=[historical_root])
    session = make_session(
        QueryResult(scalar=current_map),
        QueryResult(scalar=target),
        QueryResult(items=[invalid_first, invalid_second]),
        QueryResult(),
    )

    result = await restore_mind_map_revision(
        session,
        user_id="user-1",
        map_id="map-1",
        version=2,
        body=MindMapRevisionRestore(base_version=5, confirm=True),
    )

    assert result.root_id == "historical-root"
    assert result.current_version == 6
    assert result.deleted_node_ids == ("invalid-first", "invalid-second")


@pytest.mark.asyncio
@pytest.mark.parametrize("ref_type", ["source", "note", "wiki"])
async def test_reference_target_accepts_user_owned_records(ref_type: str) -> None:
    session = make_session(QueryResult(scalar="target-1"))

    await _validate_reference_target(
        session,
        user_id="user-1",
        mind_map=make_map(),
        ref_type=ref_type,
        ref_id="target-1",
    )


@pytest.mark.asyncio
async def test_source_chunk_reference_is_validated_through_owning_source() -> None:
    session = make_session(QueryResult(scalar=42))

    await _validate_reference_target(
        session,
        user_id="user-1",
        mind_map=make_map(),
        ref_type="source_chunk",
        ref_id="42",
    )


@pytest.mark.asyncio
async def test_source_chunk_reference_rejects_invalid_or_unowned_chunk() -> None:
    for ref_id in ("chunk-42", "42"):
        session = make_session(*([] if ref_id == "chunk-42" else [QueryResult()]))
        with pytest.raises(HTTPException) as exc:
            await _validate_reference_target(
                session,
                user_id="user-1",
                mind_map=make_map(),
                ref_type="source_chunk",
                ref_id=ref_id,
            )
        assert exc.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("ref_type", "metadata"),
    [
        ("evidence", {"asset_workspace_v1": {"evidence": [{"id": "evidence-1"}]}}),
        ("claim", {"asset_workspace_v1": {"claims": [{"id": "claim-1"}]}}),
        ("asset_block", {"asset_document": {"blocks": [{"id": "block-1"}]}}),
    ],
)
async def test_asset_internal_reference_is_scoped_to_owner_asset(
    ref_type: str,
    metadata: dict,
) -> None:
    mind_map = make_map()
    mind_map.owner_type = "asset"
    mind_map.owner_id = "asset-1"
    target_id = next(
        item["id"]
        for container in metadata.values()
        for items in container.values()
        for item in items
    )
    asset = MagicMock()
    asset.metadata_ = metadata
    session = make_session(QueryResult(scalar=asset))

    await _validate_reference_target(
        session,
        user_id="user-1",
        mind_map=mind_map,
        ref_type=ref_type,
        ref_id=target_id,
    )


@pytest.mark.asyncio
async def test_asset_internal_reference_rejects_other_asset_target() -> None:
    mind_map = make_map()
    mind_map.owner_type = "asset"
    mind_map.owner_id = "asset-1"
    asset = MagicMock()
    asset.metadata_ = {
        "asset_workspace_v1": {"claims": [{"id": "claim-from-asset-1"}]}
    }
    session = make_session(QueryResult(scalar=asset))

    with pytest.raises(HTTPException) as exc:
        await _validate_reference_target(
            session,
            user_id="user-1",
            mind_map=mind_map,
            ref_type="claim",
            ref_id="claim-from-asset-2",
        )

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_create_reference_increments_once_and_records_revision() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
        QueryResult(scalar="source-1"),
        QueryResult(),
        QueryResult(items=[]),
    )

    result = await create_mind_map_reference(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id="root",
        body=MindMapReferenceCreate(
            base_version=3,
            ref_type="source",
            ref_id="source-1",
            relation="derived_from",
        ),
    )

    assert result.previous_version == 3
    assert result.current_version == 4
    assert result.reference is not None
    assert result.reference.ref_id == "source-1"
    assert result.revision.action == "reference_added"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_reference_rejects_reference_from_another_map() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
        QueryResult(),
    )

    with pytest.raises(HTTPException) as exc:
        await update_mind_map_reference(
            session,
            user_id="user-1",
            map_id="map-1",
            node_id="root",
            reference_id="reference-from-another-map",
            body=MindMapReferenceUpdate(base_version=3, relation="supports"),
        )

    assert exc.value.status_code == 404
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_reference_increments_once_and_can_clear_selector() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    reference = make_reference("root")
    reference.fragment_selector = {"page": 2}
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
        QueryResult(scalar=reference),
        QueryResult(),
        QueryResult(items=[reference]),
    )

    result = await update_mind_map_reference(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id="root",
        reference_id=reference.id,
        body=MindMapReferenceUpdate(
            base_version=3,
            relation="supports",
            fragment_selector=None,
        ),
    )

    assert result.current_version == 4
    assert result.reference is reference
    assert reference.relation == "supports"
    assert reference.fragment_selector is None
    assert result.revision.action == "reference_updated"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_reference_increments_once_and_returns_deleted_reference() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    reference = make_reference("root")
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
        QueryResult(scalar=reference),
        QueryResult(items=[]),
    )

    result = await delete_mind_map_reference(
        session,
        user_id="user-1",
        map_id="map-1",
        node_id="root",
        reference_id=reference.id,
        body=MindMapReferenceDelete(base_version=3),
    )

    assert result.current_version == 4
    assert result.reference is reference
    assert result.revision.action == "reference_deleted"
    session.delete.assert_awaited_once_with(reference)


@pytest.mark.asyncio
async def test_reference_mutation_preserves_structured_version_conflict() -> None:
    session = make_session(QueryResult(scalar=make_map(version=4)))

    with pytest.raises(HTTPException) as exc:
        await create_mind_map_reference(
            session,
            user_id="user-1",
            map_id="map-1",
            node_id="root",
            body=MindMapReferenceCreate(
                base_version=3,
                ref_type="source",
                ref_id="source-1",
                relation="derived_from",
            ),
        )

    assert exc.value.detail["code"] == "mind_map_version_conflict"
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_reverse_reference_lookup_returns_user_scoped_results() -> None:
    reference = make_reference("root")
    session = make_session(
        QueryResult(items=[reference]),
        QueryResult(scalar=1),
    )

    items, total = await list_mind_map_references_by_target(
        session,
        user_id="user-1",
        ref_type="source_chunk",
        ref_id="42",
    )

    assert items == [reference]
    assert total == 1


def test_parse_outline_builds_stable_parent_indexes() -> None:
    parsed = parse_mind_map_outline(
        "- [id:1] Root\n  - [id:2] Existing\n    - New child\n  - Sibling"
    )

    assert [node.display_id for node in parsed] == [1, 2, None, None]
    assert [node.parent_index for node in parsed] == [None, 0, 1, 0]
    assert [node.depth for node in parsed] == [0, 1, 2, 1]


@pytest.mark.parametrize(
    "outline",
    [
        "Root",
        " - Root",
        "- Root\n    - Skipped parent",
        "- Root\n- Second root",
        "- [id:2] Root\n  - [id:2] Duplicate",
        "- Root\n\t- Tab child",
    ],
)
def test_parse_outline_rejects_invalid_tree_shapes(outline: str) -> None:
    with pytest.raises(HTTPException) as exc:
        parse_mind_map_outline(outline)

    assert exc.value.status_code == 422


def test_parse_outline_enforces_node_limit() -> None:
    outline = "\n".join(["- Root", *[f"  - Child {index}" for index in range(500)]])

    with pytest.raises(HTTPException, match="500-node limit"):
        parse_mind_map_outline(outline)


@pytest.mark.asyncio
async def test_merge_outline_updates_moves_creates_and_preserves_omitted_nodes() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    branch = make_node("branch", 2, "root", 0)
    child = make_node("child", 3, "branch", 0)
    retained = make_node("retained", 4, "root", 1)
    reference = make_reference("child")
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, branch, child, retained]),
        QueryResult(items=[reference]),
    )

    result = await apply_mind_map_outline(
        session,
        user_id="user-1",
        map_id="map-1",
        body=MindMapOutlineApply(
            base_version=3,
            mode="merge",
            outline=(
                "- [id:1] Root revised\n"
                "  - [id:4] Retained\n"
                "    - [id:2] Branch revised\n"
                "  - New branch"
            ),
        ),
    )

    assert result.current_version == 4
    assert result.outline_mode == "merge"
    assert result.created_count == 1
    assert result.updated_count == 3
    assert result.moved_count == 2
    assert result.deleted_count == 0
    assert branch.parent_id == retained.id
    assert child.parent_id == branch.id
    assert len(result.revision.snapshot["nodes"]) == 5
    assert result.revision.snapshot["references"][0]["id"] == reference.id
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_merge_outline_rejects_unknown_stable_id_without_committing() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root]),
    )

    with pytest.raises(HTTPException, match="unknown display ID 99"):
        await apply_mind_map_outline(
            session,
            user_id="user-1",
            map_id="map-1",
            body=MindMapOutlineApply(
                base_version=3,
                outline="- [id:1] Root\n  - [id:99] Unknown",
            ),
        )

    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_replace_outline_rebuilds_non_root_tree_and_drops_deleted_references() -> None:
    mind_map = make_map(version=3)
    root = make_node("root", 1, None, 0)
    branch = make_node("branch", 2, "root", 0)
    child = make_node("child", 3, "branch", 0)
    root_reference = make_reference("root")
    session = make_session(
        QueryResult(scalar=mind_map),
        QueryResult(items=[root, branch, child]),
        QueryResult(),
        QueryResult(items=[root_reference]),
    )

    result = await apply_mind_map_outline(
        session,
        user_id="user-1",
        map_id="map-1",
        body=MindMapOutlineApply(
            base_version=3,
            mode="replace",
            confirm_replace=True,
            outline="- [id:1] Root\n  - [id:5] Replacement\n    - New child",
        ),
    )

    snapshot_nodes = result.revision.snapshot["nodes"]
    assert result.outline_mode == "replace"
    assert result.created_count == 2
    assert result.deleted_count == 2
    assert result.deleted_node_ids == ("branch", "child")
    assert {node["display_id"] for node in snapshot_nodes} == {1, 5, 6}
    assert result.revision.snapshot["references"][0]["node_id"] == "root"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_outline_apply_checks_version_before_parsing() -> None:
    session = make_session(QueryResult(scalar=make_map(version=4)))

    with pytest.raises(HTTPException) as exc:
        await apply_mind_map_outline(
            session,
            user_id="user-1",
            map_id="map-1",
            body=MindMapOutlineApply(base_version=3, outline="invalid"),
        )

    assert exc.value.detail["code"] == "mind_map_version_conflict"
    session.commit.assert_not_awaited()
