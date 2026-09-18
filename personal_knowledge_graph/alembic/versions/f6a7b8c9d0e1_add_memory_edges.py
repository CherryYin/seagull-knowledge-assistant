"""add memory edges

Revision ID: f6a7b8c9d0e1
Revises: f5a6b7c8d9e0
Create Date: 2026-05-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "f5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "memory_edges",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("from_node_id", sa.String(), nullable=False),
        sa.Column("to_kind", sa.String(length=50), nullable=False),
        sa.Column("to_id", sa.String(), nullable=False),
        sa.Column("edge_type", sa.String(length=50), nullable=False),
        sa.Column("weight", sa.Float(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["from_node_id"], ["memory_nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("from_node_id", "to_kind", "to_id", "edge_type", name="uq_memory_edges_relation"),
    )
    op.create_index("idx_memory_edges_user", "memory_edges", ["user_id"])
    op.create_index("idx_memory_edges_from", "memory_edges", ["from_node_id"])
    op.create_index("idx_memory_edges_to", "memory_edges", ["to_kind", "to_id"])
    op.create_index("idx_memory_edges_type", "memory_edges", ["edge_type"])


def downgrade() -> None:
    op.drop_index("idx_memory_edges_type", table_name="memory_edges")
    op.drop_index("idx_memory_edges_to", table_name="memory_edges")
    op.drop_index("idx_memory_edges_from", table_name="memory_edges")
    op.drop_index("idx_memory_edges_user", table_name="memory_edges")
    op.drop_table("memory_edges")
