"""add note pinning, content versions, and note images

Revision ID: f5e6f7a8b9c0
Revises: f4d5e6f7a8b9
Create Date: 2026-07-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "f5e6f7a8b9c0"
down_revision: Union[str, None] = "f4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("notes", sa.Column("is_pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False))
    op.add_column("notes", sa.Column("content_versions", postgresql.JSONB(), nullable=True))
    op.create_index("idx_notes_is_pinned", "notes", ["is_pinned"])

    op.create_table(
        "note_images",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("note_id", sa.String(), nullable=False),
        sa.Column("storage_uri", sa.Text(), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=True),
        sa.Column("filename", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_note_images_note_id", "note_images", ["note_id"])


def downgrade() -> None:
    op.drop_index("ix_note_images_note_id", table_name="note_images")
    op.drop_table("note_images")
    op.drop_index("idx_notes_is_pinned", table_name="notes")
    op.drop_column("notes", "content_versions")
    op.drop_column("notes", "is_pinned")
