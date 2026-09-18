"""add recurrence to calendar reminders

Revision ID: f1a2b3c4d5e6
Revises: f7a8b9c0d1e2
Create Date: 2026-07-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "calendar_reminders",
        sa.Column("recurrence", sa.String(length=20), nullable=False, server_default="once"),
    )


def downgrade() -> None:
    op.drop_column("calendar_reminders", "recurrence")
