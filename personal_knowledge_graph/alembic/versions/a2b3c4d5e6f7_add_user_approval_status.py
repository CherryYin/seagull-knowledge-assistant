"""add user approval status

Revision ID: a2b3c4d5e6f7
Revises: f0a1b2c3d4e5
Create Date: 2026-05-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, None] = "f0a1b2c3d4e5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("approval_status", sa.String(20), server_default="approved", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("users", "approval_status")
