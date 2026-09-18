"""set null calendar note links when notes are deleted

Revision ID: e14f9c2a7b6d
Revises: e0f1a2b3c4d5
Create Date: 2026-09-14

"""

from collections.abc import Sequence

from alembic import op


revision: str = "e14f9c2a7b6d"
down_revision: str | None = "e0f1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "fk_calendar_reminders_note_id_notes",
        "calendar_reminders",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_calendar_reminders_note_id_notes",
        "calendar_reminders",
        "notes",
        ["note_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_calendar_reminders_note_id_notes",
        "calendar_reminders",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_calendar_reminders_note_id_notes",
        "calendar_reminders",
        "notes",
        ["note_id"],
        ["id"],
    )
