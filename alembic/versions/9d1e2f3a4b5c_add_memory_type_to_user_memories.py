"""add memory_type to user_memories

Revision ID: 9d1e2f3a4b5c
Revises: fc2d3e4f5a6b
Create Date: 2026-06-09 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "9d1e2f3a4b5c"
down_revision = "fc2d3e4f5a6b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_memories",
        sa.Column("memory_type", sa.String(length=50), nullable=False, server_default="profile"),
    )


def downgrade() -> None:
    op.drop_column("user_memories", "memory_type")
