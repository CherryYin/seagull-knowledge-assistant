"""add knowledge_stats table

Revision ID: d2e3f4a5b6c7
Revises: c8d9e0f1a2b3
Create Date: 2026-04-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "d2e3f4a5b6c7"
down_revision: Union[str, None] = "c8d9e0f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "knowledge_stats",
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("item_type", sa.String(10), nullable=False),
        sa.Column("search_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("retrieval_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("reference_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "last_accessed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("item_id", "item_type"),
    )
    # Indexes for common sort queries
    op.create_index(
        "ix_knowledge_stats_search",
        "knowledge_stats",
        ["item_type", sa.text("search_count DESC")],
    )
    op.create_index(
        "ix_knowledge_stats_retrieval",
        "knowledge_stats",
        ["item_type", sa.text("retrieval_count DESC")],
    )
    op.create_index(
        "ix_knowledge_stats_reference",
        "knowledge_stats",
        ["item_type", sa.text("reference_count DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_stats_reference", table_name="knowledge_stats")
    op.drop_index("ix_knowledge_stats_retrieval", table_name="knowledge_stats")
    op.drop_index("ix_knowledge_stats_search", table_name="knowledge_stats")
    op.drop_table("knowledge_stats")
