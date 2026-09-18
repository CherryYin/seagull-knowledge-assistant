"""add note link to calendar reminders

Revision ID: f4d5e6f7a8b9
Revises: f3c4d5e6f7a8
Create Date: 2026-07-14 00:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f4d5e6f7a8b9"
down_revision: Union[str, None] = "f3c4d5e6f7a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("calendar_reminders", sa.Column("note_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_calendar_reminders_note_id_notes",
        "calendar_reminders",
        "notes",
        ["note_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_calendar_reminders_note_id_notes", "calendar_reminders", type_="foreignkey")
    op.drop_column("calendar_reminders", "note_id")
