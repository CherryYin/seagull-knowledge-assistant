"""add paper discovery tables

Revision ID: a9b8c7d6e5f4
Revises: f8a9b0c1d2e3
Create Date: 2026-06-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a9b8c7d6e5f4"
down_revision: Union[str, None] = "f8a9b0c1d2e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "paper_discovery_profiles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("goal_prompt", sa.Text(), nullable=True),
        sa.Column("mode", sa.String(length=20), server_default="query", nullable=False),
        sa.Column("provider", sa.String(length=50), server_default="semantic_scholar", nullable=False),
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("max_results", sa.Integer(), server_default="20", nullable=False),
        sa.Column("time_window_days", sa.Integer(), nullable=True),
        sa.Column("include_terms", JSONB(), nullable=True),
        sa.Column("exclude_terms", JSONB(), nullable=True),
        sa.Column("preferred_authors", JSONB(), nullable=True),
        sa.Column("preferred_venues", JSONB(), nullable=True),
        sa.Column("preferred_fields", JSONB(), nullable=True),
        sa.Column("preferred_arxiv_categories", JSONB(), nullable=True),
        sa.Column("seed_paper_ids", JSONB(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_paper_discovery_profile_user_name"),
    )
    op.create_index("idx_paper_discovery_profiles_user_enabled", "paper_discovery_profiles", ["user_id", "is_enabled"])
    op.create_index("idx_paper_discovery_profiles_provider", "paper_discovery_profiles", ["provider"])

    op.create_table(
        "paper_discovery_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("mode", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=30), server_default="pending", nullable=False),
        sa.Column("query_bundle", JSONB(), nullable=True),
        sa.Column("stats", JSONB(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["profile_id"], ["paper_discovery_profiles.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_paper_discovery_runs_profile_started", "paper_discovery_runs", ["profile_id", "started_at"])
    op.create_index("idx_paper_discovery_runs_user_status", "paper_discovery_runs", ["user_id", "status"])

    op.create_table(
        "paper_trend_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("scope_key", sa.String(length=255), nullable=False),
        sa.Column("window_start", sa.DateTime(), nullable=False),
        sa.Column("window_end", sa.DateTime(), nullable=False),
        sa.Column("topic", sa.String(length=255), nullable=True),
        sa.Column("term", sa.String(length=255), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column("baseline_count", sa.Integer(), nullable=True),
        sa.Column("growth_rate", sa.Float(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["paper_discovery_profiles.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "provider",
            "scope_key",
            "window_start",
            "window_end",
            "term",
            name="uq_paper_trend_snapshot_window_term",
        ),
    )
    op.create_index("idx_paper_trend_snapshots_user_created", "paper_trend_snapshots", ["user_id", "created_at"])
    op.create_index("idx_paper_trend_snapshots_profile_window", "paper_trend_snapshots", ["profile_id", "window_end"])


def downgrade() -> None:
    op.drop_index("idx_paper_trend_snapshots_profile_window", table_name="paper_trend_snapshots")
    op.drop_index("idx_paper_trend_snapshots_user_created", table_name="paper_trend_snapshots")
    op.drop_table("paper_trend_snapshots")

    op.drop_index("idx_paper_discovery_runs_user_status", table_name="paper_discovery_runs")
    op.drop_index("idx_paper_discovery_runs_profile_started", table_name="paper_discovery_runs")
    op.drop_table("paper_discovery_runs")

    op.drop_index("idx_paper_discovery_profiles_provider", table_name="paper_discovery_profiles")
    op.drop_index("idx_paper_discovery_profiles_user_enabled", table_name="paper_discovery_profiles")
    op.drop_table("paper_discovery_profiles")
