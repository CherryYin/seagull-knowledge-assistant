"""add digest note retention fields

Revision ID: f9b0c1d2e3f4
Revises: f9a0b1c2d3e4
Create Date: 2026-05-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "f9b0c1d2e3f4"
down_revision = "f9a0b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notes", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("notes", sa.Column("kept_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("idx_notes_expires_at", "notes", ["expires_at"])
    op.execute(
        """
        UPDATE notes
        SET expires_at = created_at + interval '7 days'
        WHERE note_type = 'digest'
          AND status = 'pending_review'
          AND expires_at IS NULL
        """
    )
    op.execute(
        """
        UPDATE notes
        SET kept_at = updated_at
        WHERE note_type = 'digest'
          AND status <> 'pending_review'
          AND kept_at IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("idx_notes_expires_at", table_name="notes")
    op.drop_column("notes", "kept_at")
    op.drop_column("notes", "expires_at")
