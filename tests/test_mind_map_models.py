from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from pkg.models.application.mind_map import (
    MindMap,
    MindMapNode,
    MindMapNodeReference,
    MindMapRevision,
)
from pkg.models.user import User  # noqa: F401


def constraint_names(model) -> set[str]:
    return {constraint.name for constraint in model.__table__.constraints if constraint.name}


def index_names(model) -> set[str]:
    return {index.name for index in model.__table__.indexes}


def test_mind_map_owner_and_version_constraints() -> None:
    columns = MindMap.__table__.columns

    assert str(columns.version.server_default.arg) == "1"
    assert str(columns.layout_mode.server_default.arg) == "balanced"
    assert str(columns.generation_status.server_default.arg) == "manual"
    assert columns.basis_revision.nullable is False
    assert {
        "uq_mind_maps_user_owner_purpose",
        "ck_mind_maps_owner_purpose",
        "ck_mind_maps_version_positive",
    } <= constraint_names(MindMap)
    assert {"idx_mind_maps_user_id", "idx_mind_maps_owner"} <= index_names(MindMap)


def test_node_parent_foreign_key_stays_within_the_same_map() -> None:
    table = MindMapNode.__table__
    parent_constraint = next(
        constraint
        for constraint in table.foreign_key_constraints
        if constraint.name == "fk_mind_map_nodes_parent_same_map"
    )

    assert [column.name for column in parent_constraint.columns] == ["map_id", "parent_id"]
    assert [element.target_fullname for element in parent_constraint.elements] == [
        "mind_map_nodes.map_id",
        "mind_map_nodes.id",
    ]
    assert parent_constraint.ondelete == "CASCADE"
    assert "uq_mind_map_nodes_display_id" in constraint_names(MindMapNode)
    assert "idx_mind_map_nodes_siblings" in index_names(MindMapNode)


def test_reference_target_foreign_key_stays_within_the_same_map() -> None:
    table = MindMapNodeReference.__table__
    node_constraint = next(
        constraint
        for constraint in table.foreign_key_constraints
        if constraint.name == "fk_mind_map_node_references_node_same_map"
    )

    assert [column.name for column in node_constraint.columns] == ["map_id", "node_id"]
    assert node_constraint.ondelete == "CASCADE"
    assert "idx_mind_map_node_references_target" in index_names(MindMapNodeReference)
    assert "uq_mind_map_node_references_target_relation" in constraint_names(
        MindMapNodeReference
    )


def test_revision_versions_are_unique_per_map() -> None:
    assert "uq_mind_map_revisions_version" in constraint_names(MindMapRevision)
    assert "ck_mind_map_revisions_version_positive" in constraint_names(MindMapRevision)
    assert "idx_mind_map_revisions_map_created" in index_names(MindMapRevision)


def test_all_mind_map_tables_compile_for_postgresql() -> None:
    for model in (MindMap, MindMapNode, MindMapNodeReference, MindMapRevision):
        statement = str(CreateTable(model.__table__).compile(dialect=postgresql.dialect()))
        assert f"CREATE TABLE {model.__tablename__}" in statement


def test_mind_map_migration_is_the_single_alembic_head() -> None:
    scripts = ScriptDirectory.from_config(Config("alembic.ini"))
    revision = scripts.get_revision("d9e0f1a2b3c4")

    assert scripts.get_heads() == ["d9e0f1a2b3c4"]
    assert revision is not None
    assert revision.down_revision == "b7c8d9e0f1a6"
