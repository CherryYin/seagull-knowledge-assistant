"""add review suggestions

Revision ID: fa1b2c3d4e5f
Revises: f9b0c1d2e3f4
Create Date: 2026-05-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "fa1b2c3d4e5f"
down_revision: Union[str, None] = "f9b0c1d2e3f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "review_suggestions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("suggestion_type", sa.String(length=50), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", sa.String(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("proposed_value", JSONB(), nullable=True),
        sa.Column("evidence", JSONB(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default="pending", nullable=False),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("applied_at", sa.DateTime(), nullable=True),
        sa.Column("reviewer_note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "suggestion_type",
            "target_type",
            "target_id",
            "status",
            name="uq_review_suggestions_open_target",
        ),
    )
    op.create_index("idx_review_suggestions_user", "review_suggestions", ["user_id"])
    op.create_index("idx_review_suggestions_type", "review_suggestions", ["suggestion_type"])
    op.create_index("idx_review_suggestions_status", "review_suggestions", ["status"])
    op.create_index("idx_review_suggestions_target", "review_suggestions", ["target_type", "target_id"])


def downgrade() -> None:
    op.drop_index("idx_review_suggestions_target", table_name="review_suggestions")
    op.drop_index("idx_review_suggestions_status", table_name="review_suggestions")
    op.drop_index("idx_review_suggestions_type", table_name="review_suggestions")
    op.drop_index("idx_review_suggestions_user", table_name="review_suggestions")
    op.drop_table("review_suggestions")
