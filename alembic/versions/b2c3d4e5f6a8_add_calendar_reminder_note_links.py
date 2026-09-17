"""add calendar reminder note links

Revision ID: b2c3d4e5f6a8
Revises: a1b2c3d4e5f7
Create Date: 2026-09-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a8"
down_revision: str | None = "a1b2c3d4e5f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calendar_reminder_notes",
        sa.Column("reminder_id", sa.String(), nullable=False),
        sa.Column("note_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(
            ["reminder_id"],
            ["calendar_reminders.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("reminder_id", "note_id"),
    )
    op.create_index(
        "idx_calendar_reminder_notes_note_id",
        "calendar_reminder_notes",
        ["note_id"],
    )
    op.execute(
        sa.text(
            """
            INSERT INTO calendar_reminder_notes (reminder_id, note_id, position)
            SELECT id, note_id, 0
            FROM calendar_reminders
            WHERE note_id IS NOT NULL
            ON CONFLICT DO NOTHING
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE calendar_reminders AS reminder
            SET note_id = links.note_id
            FROM (
                SELECT DISTINCT ON (reminder_id) reminder_id, note_id
                FROM calendar_reminder_notes
                ORDER BY reminder_id, position, note_id
            ) AS links
            WHERE reminder.id = links.reminder_id
            """
        )
    )
    op.drop_index("idx_calendar_reminder_notes_note_id", table_name="calendar_reminder_notes")
    op.drop_table("calendar_reminder_notes")
