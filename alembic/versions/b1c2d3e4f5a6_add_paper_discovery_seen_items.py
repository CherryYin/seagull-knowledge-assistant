"""add paper discovery seen items

Revision ID: b1c2d3e4f5a6
Revises: a9b8c7d6e5f4
Create Date: 2026-06-04 00:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, None] = "a9b8c7d6e5f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("paper_discovery_profiles", sa.Column("schedule", sa.String(length=20), server_default="manual", nullable=False))
    op.add_column("paper_discovery_profiles", sa.Column("discovery_window_days", sa.Integer(), server_default="365", nullable=False))

    op.create_table(
        "paper_discovery_seen_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("item_key", sa.String(), nullable=False),
        sa.Column("paper_provider_id", sa.String(), nullable=True),
        sa.Column("arxiv_id", sa.String(length=64), nullable=True),
        sa.Column("doi", sa.String(length=255), nullable=True),
        sa.Column("first_seen_run_id", sa.Integer(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["profile_id"], ["paper_discovery_profiles.id"]),
        sa.ForeignKeyConstraint(["first_seen_run_id"], ["paper_discovery_runs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "profile_id", "provider", "item_key", name="uq_paper_discovery_seen_item"),
    )
    op.create_index("idx_paper_discovery_seen_profile", "paper_discovery_seen_items", ["profile_id", "first_seen_at"])
    op.create_index("idx_paper_discovery_seen_arxiv", "paper_discovery_seen_items", ["arxiv_id"])


def downgrade() -> None:
    op.drop_index("idx_paper_discovery_seen_arxiv", table_name="paper_discovery_seen_items")
    op.drop_index("idx_paper_discovery_seen_profile", table_name="paper_discovery_seen_items")
    op.drop_table("paper_discovery_seen_items")
    op.drop_column("paper_discovery_profiles", "discovery_window_days")
    op.drop_column("paper_discovery_profiles", "schedule")
