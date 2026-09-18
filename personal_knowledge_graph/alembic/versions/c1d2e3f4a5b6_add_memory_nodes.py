"""add memory nodes

Revision ID: c1d2e3f4a5b6
Revises: b9c8d7e6f5a4
Create Date: 2026-05-20 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "c1d2e3f4a5b6"
down_revision: Union[str, None] = "b9c8d7e6f5a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "memory_nodes",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("node_type", sa.String(length=50), nullable=False),
        sa.Column("scope_id", sa.String(length=200), nullable=False),
        sa.Column("level", sa.String(length=50), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("child_node_ids", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("derived_from_notes", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("derived_from_sources", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("derived_from_chunks", ARRAY(sa.Integer()), server_default="{}", nullable=False),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("confidence_score", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "node_type", "scope_id", "level", name="uq_memory_nodes_scope"),
    )
    op.create_index("idx_memory_nodes_user_id", "memory_nodes", ["user_id"])
    op.create_index("idx_memory_nodes_type_level", "memory_nodes", ["node_type", "level"])
    op.create_index("idx_memory_nodes_scope", "memory_nodes", ["scope_id"])
    op.create_index("idx_memory_nodes_notes", "memory_nodes", ["derived_from_notes"], postgresql_using="gin")
    op.create_index("idx_memory_nodes_sources", "memory_nodes", ["derived_from_sources"], postgresql_using="gin")


def downgrade() -> None:
    op.drop_index("idx_memory_nodes_sources", table_name="memory_nodes")
    op.drop_index("idx_memory_nodes_notes", table_name="memory_nodes")
    op.drop_index("idx_memory_nodes_scope", table_name="memory_nodes")
    op.drop_index("idx_memory_nodes_type_level", table_name="memory_nodes")
    op.drop_index("idx_memory_nodes_user_id", table_name="memory_nodes")
    op.drop_table("memory_nodes")
