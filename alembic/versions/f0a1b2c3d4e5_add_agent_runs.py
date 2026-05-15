"""add agent runs

Revision ID: f0a1b2c3d4e5
Revises: e1f2a3b4c5d6
Create Date: 2026-05-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f0a1b2c3d4e5"
down_revision: Union[str, None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("profile_id", sa.String(), sa.ForeignKey("agent_profiles.id"), nullable=True),
        sa.Column("agent_type", sa.String(length=50), nullable=False, server_default="action"),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="queued"),
        sa.Column("task", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("result_preview", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_agent_runs_user_id", "agent_runs", ["user_id"])
    op.create_index("idx_agent_runs_profile_id", "agent_runs", ["profile_id"])
    op.create_index("idx_agent_runs_status", "agent_runs", ["status"])
    op.create_index("idx_agent_runs_updated_at", "agent_runs", ["updated_at"])

    op.create_table(
        "agent_run_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "run_id",
            sa.String(),
            sa.ForeignKey("agent_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("event_type", sa.String(length=50), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("metadata", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_agent_run_events_run_id", "agent_run_events", ["run_id"])
    op.create_index("idx_agent_run_events_user_id", "agent_run_events", ["user_id"])
    op.create_index("idx_agent_run_events_created_at", "agent_run_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_agent_run_events_created_at", table_name="agent_run_events")
    op.drop_index("idx_agent_run_events_user_id", table_name="agent_run_events")
    op.drop_index("idx_agent_run_events_run_id", table_name="agent_run_events")
    op.drop_table("agent_run_events")
    op.drop_index("idx_agent_runs_updated_at", table_name="agent_runs")
    op.drop_index("idx_agent_runs_status", table_name="agent_runs")
    op.drop_index("idx_agent_runs_profile_id", table_name="agent_runs")
    op.drop_index("idx_agent_runs_user_id", table_name="agent_runs")
    op.drop_table("agent_runs")
