"""add github trend profiles

Revision ID: e5f6a7b8c9d0
Revises: e4c5d6e7f8a9
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | None = "e4c5d6e7f8a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "github_trend_profiles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("language", sa.String(length=80), nullable=True),
        sa.Column("schedule", sa.String(length=20), server_default="manual", nullable=False),
        sa.Column("is_enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("candidate_count", sa.Integer(), server_default="25", nullable=False),
        sa.Column("top_k", sa.Integer(), server_default="5", nullable=False),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_github_trend_profile_user_name"),
    )
    op.create_index(
        "idx_github_trend_profiles_user_enabled",
        "github_trend_profiles",
        ["user_id", "is_enabled"],
    )
    op.create_index(
        "idx_github_trend_profiles_schedule",
        "github_trend_profiles",
        ["schedule", "last_run_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_github_trend_profiles_schedule", table_name="github_trend_profiles")
    op.drop_index("idx_github_trend_profiles_user_enabled", table_name="github_trend_profiles")
    op.drop_table("github_trend_profiles")
