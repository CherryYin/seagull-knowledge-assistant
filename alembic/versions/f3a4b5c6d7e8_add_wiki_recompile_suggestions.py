"""add wiki recompile suggestions

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-05-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wiki_recompile_suggestions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("wiki_id", sa.String(), nullable=False),
        sa.Column("trigger_type", sa.String(length=50), nullable=False),
        sa.Column("trigger_id", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("evidence_preview", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default="pending", nullable=False),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["wiki_id"], ["wiki_pages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "wiki_id",
            "trigger_type",
            "trigger_id",
            "status",
            name="uq_wiki_recompile_suggestions_open_trigger",
        ),
    )
    op.create_index("idx_wiki_recompile_suggestions_user", "wiki_recompile_suggestions", ["user_id"])
    op.create_index("idx_wiki_recompile_suggestions_wiki", "wiki_recompile_suggestions", ["wiki_id"])
    op.create_index("idx_wiki_recompile_suggestions_status", "wiki_recompile_suggestions", ["status"])
    op.create_index(
        "idx_wiki_recompile_suggestions_trigger",
        "wiki_recompile_suggestions",
        ["trigger_type", "trigger_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_wiki_recompile_suggestions_trigger", table_name="wiki_recompile_suggestions")
    op.drop_index("idx_wiki_recompile_suggestions_status", table_name="wiki_recompile_suggestions")
    op.drop_index("idx_wiki_recompile_suggestions_wiki", table_name="wiki_recompile_suggestions")
    op.drop_index("idx_wiki_recompile_suggestions_user", table_name="wiki_recompile_suggestions")
    op.drop_table("wiki_recompile_suggestions")
