"""add calendar reminder completions

Revision ID: f2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-07-13 00:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f2b3c4d5e6f7"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "calendar_reminder_completions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("reminder_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("occurrence_date", sa.String(length=10), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["reminder_id"], ["calendar_reminders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("reminder_id", "occurrence_date", name="uq_calendar_reminder_completion_occurrence"),
    )
    op.create_index(
        "idx_calendar_reminder_completions_user_date",
        "calendar_reminder_completions",
        ["user_id", "occurrence_date"],
    )


def downgrade() -> None:
    op.drop_index("idx_calendar_reminder_completions_user_date", table_name="calendar_reminder_completions")
    op.drop_table("calendar_reminder_completions")
