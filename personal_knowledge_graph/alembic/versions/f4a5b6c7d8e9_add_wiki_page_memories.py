"""add wiki page memories

Revision ID: f4a5b6c7d8e9
Revises: f3a4b5c6d7e8
Create Date: 2026-05-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f4a5b6c7d8e9"
down_revision: Union[str, None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wiki_page_memories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("wiki_id", sa.String(), nullable=False),
        sa.Column("memory_node_id", sa.String(), nullable=False),
        sa.Column("relevance_summary", sa.Text(), nullable=False),
        sa.Column("key_points", JSONB(), nullable=True),
        sa.Column("supporting_claims", JSONB(), nullable=True),
        sa.Column("confidence_score", sa.Float(), nullable=True),
        sa.Column("last_refreshed_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["wiki_id"], ["wiki_pages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["memory_node_id"], ["memory_nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("wiki_id", "memory_node_id", name="uq_wiki_page_memories_wiki_memory"),
    )
    op.create_index("idx_wiki_page_memories_wiki", "wiki_page_memories", ["wiki_id"])
    op.create_index("idx_wiki_page_memories_memory", "wiki_page_memories", ["memory_node_id"])


def downgrade() -> None:
    op.drop_index("idx_wiki_page_memories_memory", table_name="wiki_page_memories")
    op.drop_index("idx_wiki_page_memories_wiki", table_name="wiki_page_memories")
    op.drop_table("wiki_page_memories")
