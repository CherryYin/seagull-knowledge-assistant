"""add Harness session persistence tables and metadata

Revision ID: a6b7c8d9e0f1
Revises: f5e6f7a8b9c0
Create Date: 2026-08-20 00:00:00.000000

"""
from typing import Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "a6b7c8d9e0f1"
down_revision: Union[str, None] = "f5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("harness_format_version", sa.Integer(), nullable=True))
    op.add_column("chat_sessions", sa.Column("harness_created_at_ms", sa.BigInteger(), nullable=True))
    op.add_column("chat_sessions", sa.Column("cwd", sa.Text(), nullable=True))
    op.add_column("chat_sessions", sa.Column("parent_session_id", sa.String(), nullable=True))
    op.add_column("chat_sessions", sa.Column("seed_length", sa.Integer(), nullable=True))
    op.add_column("chat_sessions", sa.Column("origin", sa.String(length=30), nullable=True))
    op.add_column("chat_sessions", sa.Column("delegation_depth", sa.Integer(), nullable=True))
    op.add_column("chat_sessions", sa.Column("agent_preset", sa.Text(), nullable=True))
    op.add_column("chat_sessions", sa.Column("persistence_incarnation", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column(
        "chat_sessions",
        sa.Column("persistence_revision", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("next_event_seq", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("projection_seq", sa.BigInteger(), server_default=sa.text("-1"), nullable=False),
    )
    op.add_column("chat_sessions", sa.Column("materialized_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        "ck_chat_sessions_harness_created_at_ms",
        "chat_sessions",
        "harness_created_at_ms IS NULL OR harness_created_at_ms >= 0",
    )
    op.create_check_constraint(
        "ck_chat_sessions_seed_length",
        "chat_sessions",
        "seed_length IS NULL OR seed_length >= 0",
    )
    op.create_check_constraint(
        "ck_chat_sessions_origin",
        "chat_sessions",
        "origin IS NULL OR origin = 'subagent'",
    )
    op.create_check_constraint(
        "ck_chat_sessions_delegation_depth",
        "chat_sessions",
        "delegation_depth IS NULL OR delegation_depth >= 0",
    )
    op.create_check_constraint(
        "ck_chat_sessions_persistence_revision",
        "chat_sessions",
        "persistence_revision >= 0",
    )
    op.create_check_constraint("ck_chat_sessions_next_event_seq", "chat_sessions", "next_event_seq >= 0")
    op.create_check_constraint("ck_chat_sessions_projection_seq", "chat_sessions", "projection_seq >= -1")
    op.create_index("ix_chat_sessions_parent_session_id", "chat_sessions", ["parent_session_id"])
    op.create_index("ix_chat_sessions_materialized_at", "chat_sessions", ["materialized_at"])

    op.create_table(
        "chat_session_events",
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("time_ms", sa.BigInteger(), nullable=False),
        sa.Column("data", postgresql.JSON(), nullable=False),
        sa.Column("source_event_seqs", postgresql.JSON(), nullable=True),
        sa.Column("surface_op", postgresql.JSON(), nullable=True),
        sa.Column("ignorable", sa.Boolean(), nullable=True),
        sa.CheckConstraint("seq >= 0", name="ck_chat_session_events_seq"),
        sa.CheckConstraint("time_ms >= 0", name="ck_chat_session_events_time_ms"),
        sa.ForeignKeyConstraint(["session_id"], ["chat_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id", "seq"),
    )
    op.create_index(
        "ix_chat_session_events_type",
        "chat_session_events",
        ["session_id", "type", "seq"],
    )

    persistence_state = op.create_table(
        "harness_persistence_state",
        sa.Column("singleton", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("store_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.CheckConstraint("singleton", name="ck_harness_persistence_state_singleton"),
        sa.PrimaryKeyConstraint("singleton"),
    )
    op.bulk_insert(
        persistence_state,
        [{"singleton": True, "store_id": uuid.uuid4(), "schema_version": 1}],
    )


def downgrade() -> None:
    op.drop_table("harness_persistence_state")
    op.drop_index("ix_chat_session_events_type", table_name="chat_session_events")
    op.drop_table("chat_session_events")
    op.drop_index("ix_chat_sessions_materialized_at", table_name="chat_sessions")
    op.drop_index("ix_chat_sessions_parent_session_id", table_name="chat_sessions")
    op.drop_constraint("ck_chat_sessions_projection_seq", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_next_event_seq", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_persistence_revision", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_delegation_depth", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_origin", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_seed_length", "chat_sessions", type_="check")
    op.drop_constraint("ck_chat_sessions_harness_created_at_ms", "chat_sessions", type_="check")
    op.drop_column("chat_sessions", "materialized_at")
    op.drop_column("chat_sessions", "projection_seq")
    op.drop_column("chat_sessions", "next_event_seq")
    op.drop_column("chat_sessions", "persistence_revision")
    op.drop_column("chat_sessions", "persistence_incarnation")
    op.drop_column("chat_sessions", "agent_preset")
    op.drop_column("chat_sessions", "delegation_depth")
    op.drop_column("chat_sessions", "origin")
    op.drop_column("chat_sessions", "seed_length")
    op.drop_column("chat_sessions", "parent_session_id")
    op.drop_column("chat_sessions", "cwd")
    op.drop_column("chat_sessions", "harness_created_at_ms")
    op.drop_column("chat_sessions", "harness_format_version")
