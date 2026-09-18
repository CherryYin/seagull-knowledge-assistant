"""add system jobs

Revision ID: fa3b4c5d6e7f
Revises: fa2b3c4d5e6f
Create Date: 2026-05-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "fa3b4c5d6e7f"
down_revision: Union[str, None] = "fa2b3c4d5e6f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "system_jobs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("job_type", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=30), server_default="running", nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("duration_ms", sa.Float(), nullable=True),
        sa.Column("started_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_system_jobs_type", "system_jobs", ["job_type"])
    op.create_index("idx_system_jobs_status", "system_jobs", ["status"])
    op.create_index("idx_system_jobs_started_at", "system_jobs", ["started_at"])


def downgrade() -> None:
    op.drop_index("idx_system_jobs_started_at", table_name="system_jobs")
    op.drop_index("idx_system_jobs_status", table_name="system_jobs")
    op.drop_index("idx_system_jobs_type", table_name="system_jobs")
    op.drop_table("system_jobs")
