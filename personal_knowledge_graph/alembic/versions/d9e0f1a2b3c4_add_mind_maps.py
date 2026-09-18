"""add mind map foundation tables

Revision ID: d9e0f1a2b3c4
Revises: b7c8d9e0f1a6
Create Date: 2026-09-08

"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "d9e0f1a2b3c4"
down_revision: str | None = "b7c8d9e0f1a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mind_maps",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("owner_type", sa.String(length=20), nullable=False),
        sa.Column("owner_id", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(length=40), nullable=False),
        sa.Column(
            "layout_mode",
            sa.String(length=20),
            server_default=sa.text("'balanced'"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column(
            "basis_revision",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "generation_status",
            sa.String(length=20),
            server_default=sa.text("'manual'"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "generation_status IN ('manual', 'generating', 'ready', 'stale', 'failed')",
            name="ck_mind_maps_generation_status",
        ),
        sa.CheckConstraint(
            "layout_mode IN ('balanced', 'right')",
            name="ck_mind_maps_layout_mode",
        ),
        sa.CheckConstraint(
            "(owner_type = 'source' AND purpose = 'document_overview') OR "
            "(owner_type = 'asset' AND purpose IN ('asset_outline', 'asset_reasoning'))",
            name="ck_mind_maps_owner_purpose",
        ),
        sa.CheckConstraint(
            "owner_type IN ('source', 'asset')",
            name="ck_mind_maps_owner_type",
        ),
        sa.CheckConstraint(
            "purpose IN ('document_overview', 'asset_outline', 'asset_reasoning')",
            name="ck_mind_maps_purpose",
        ),
        sa.CheckConstraint("version >= 1", name="ck_mind_maps_version_positive"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "owner_type",
            "owner_id",
            "purpose",
            name="uq_mind_maps_user_owner_purpose",
        ),
    )
    op.create_index("idx_mind_maps_generation_status", "mind_maps", ["generation_status"])
    op.create_index("idx_mind_maps_owner", "mind_maps", ["owner_type", "owner_id"])
    op.create_index("idx_mind_maps_user_id", "mind_maps", ["user_id"])

    op.create_table(
        "mind_map_nodes",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("map_id", sa.String(), nullable=False),
        sa.Column("display_id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.String(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "collapsed",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "node_kind",
            sa.String(length=20),
            server_default=sa.text("'topic'"),
            nullable=False,
        ),
        sa.Column(
            "updated_by",
            sa.String(length=20),
            server_default=sa.text("'human'"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "display_id >= 1",
            name="ck_mind_map_nodes_display_id_positive",
        ),
        sa.CheckConstraint(
            "node_kind IN ('topic', 'section', 'concept', 'claim', 'evidence', "
            "'block', 'knowledge', 'question')",
            name="ck_mind_map_nodes_kind",
        ),
        sa.CheckConstraint(
            "parent_id IS NULL OR parent_id <> id",
            name="ck_mind_map_nodes_not_self_parent",
        ),
        sa.CheckConstraint(
            "position >= 0",
            name="ck_mind_map_nodes_position_nonnegative",
        ),
        sa.CheckConstraint(
            "updated_by IN ('human', 'agent', 'system')",
            name="ck_mind_map_nodes_updated_by",
        ),
        sa.ForeignKeyConstraint(["map_id"], ["mind_maps.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["map_id", "parent_id"],
            ["mind_map_nodes.map_id", "mind_map_nodes.id"],
            name="fk_mind_map_nodes_parent_same_map",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("map_id", "display_id", name="uq_mind_map_nodes_display_id"),
        sa.UniqueConstraint("map_id", "id", name="uq_mind_map_nodes_map_id_id"),
    )
    op.create_index("idx_mind_map_nodes_map_id", "mind_map_nodes", ["map_id"])
    op.create_index(
        "idx_mind_map_nodes_siblings",
        "mind_map_nodes",
        ["map_id", "parent_id", "position"],
    )

    op.create_table(
        "mind_map_node_references",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("map_id", sa.String(), nullable=False),
        sa.Column("node_id", sa.String(), nullable=False),
        sa.Column("ref_type", sa.String(length=30), nullable=False),
        sa.Column("ref_id", sa.String(), nullable=False),
        sa.Column("relation", sa.String(length=30), nullable=False),
        sa.Column(
            "fragment_selector",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "ref_type IN ('source', 'source_chunk', 'evidence', 'claim', "
            "'asset_block', 'note', 'wiki')",
            name="ck_mind_map_node_references_type",
        ),
        sa.CheckConstraint(
            "relation IN ('derived_from', 'represents', 'supports', 'contradicts', "
            "'elaborates', 'navigates_to')",
            name="ck_mind_map_node_references_relation",
        ),
        sa.ForeignKeyConstraint(["map_id"], ["mind_maps.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["map_id", "node_id"],
            ["mind_map_nodes.map_id", "mind_map_nodes.id"],
            name="fk_mind_map_node_references_node_same_map",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "node_id",
            "ref_type",
            "ref_id",
            "relation",
            name="uq_mind_map_node_references_target_relation",
        ),
    )
    op.create_index(
        "idx_mind_map_node_references_node_id",
        "mind_map_node_references",
        ["node_id"],
    )
    op.create_index(
        "idx_mind_map_node_references_target",
        "mind_map_node_references",
        ["ref_type", "ref_id"],
    )

    op.create_table(
        "mind_map_revisions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("map_id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("actor_type", sa.String(length=20), nullable=False),
        sa.Column("actor_ref", sa.String(), nullable=True),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "action IN ('map_created', 'map_updated', 'outline_applied', 'node_added', "
            "'node_updated', 'node_moved', 'node_deleted', 'reference_added', "
            "'reference_updated', 'reference_deleted', 'restored')",
            name="ck_mind_map_revisions_action",
        ),
        sa.CheckConstraint(
            "actor_type IN ('human', 'agent', 'system')",
            name="ck_mind_map_revisions_actor_type",
        ),
        sa.CheckConstraint(
            "version >= 1",
            name="ck_mind_map_revisions_version_positive",
        ),
        sa.ForeignKeyConstraint(["map_id"], ["mind_maps.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("map_id", "version", name="uq_mind_map_revisions_version"),
    )
    op.create_index(
        "idx_mind_map_revisions_map_created",
        "mind_map_revisions",
        ["map_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_mind_map_revisions_map_created", table_name="mind_map_revisions")
    op.drop_table("mind_map_revisions")
    op.drop_index(
        "idx_mind_map_node_references_target",
        table_name="mind_map_node_references",
    )
    op.drop_index(
        "idx_mind_map_node_references_node_id",
        table_name="mind_map_node_references",
    )
    op.drop_table("mind_map_node_references")
    op.drop_index("idx_mind_map_nodes_siblings", table_name="mind_map_nodes")
    op.drop_index("idx_mind_map_nodes_map_id", table_name="mind_map_nodes")
    op.drop_table("mind_map_nodes")
    op.drop_index("idx_mind_maps_user_id", table_name="mind_maps")
    op.drop_index("idx_mind_maps_owner", table_name="mind_maps")
    op.drop_index("idx_mind_maps_generation_status", table_name="mind_maps")
    op.drop_table("mind_maps")
