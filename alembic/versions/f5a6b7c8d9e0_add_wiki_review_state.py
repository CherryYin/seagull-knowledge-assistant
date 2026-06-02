"""add wiki review state

Revision ID: f5a6b7c8d9e0
Revises: f4a5b6c7d8e9
Create Date: 2026-05-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f5a6b7c8d9e0"
down_revision: Union[str, None] = "f4a5b6c7d8e9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("wiki_pages", sa.Column("stale_reason", sa.Text(), nullable=True))
    op.add_column("wiki_pages", sa.Column("stale_triggered_at", sa.DateTime(), nullable=True))
    op.add_column("wiki_recompile_suggestions", sa.Column("reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("wiki_recompile_suggestions", sa.Column("applied_at", sa.DateTime(), nullable=True))
    op.add_column("wiki_recompile_suggestions", sa.Column("reviewer_note", sa.Text(), nullable=True))
    op.create_index(
        "idx_wiki_pages_stale_triggered_at",
        "wiki_pages",
        ["stale_triggered_at"],
        postgresql_where=sa.text("stale_triggered_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_wiki_pages_stale_triggered_at", table_name="wiki_pages")
    op.drop_column("wiki_recompile_suggestions", "reviewer_note")
    op.drop_column("wiki_recompile_suggestions", "applied_at")
    op.drop_column("wiki_recompile_suggestions", "reviewed_at")
    op.drop_column("wiki_pages", "stale_triggered_at")
    op.drop_column("wiki_pages", "stale_reason")
