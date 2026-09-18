"""add source media derivatives

Revision ID: e6f7a8b9c0d1
Revises: e5f6a7b8c9d0
Create Date: 2026-09-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: str | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "source_media",
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("mime_type", sa.String(length=120), nullable=True),
        sa.Column("file_size", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("thumbnail_path", sa.Text(), nullable=True),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column("caption_model", sa.String(length=200), nullable=True),
        sa.Column("processing_status", sa.String(length=30), server_default="pending", nullable=False),
        sa.Column("processing_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("processing_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_retry_at", sa.DateTime(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("source_id"),
    )
    op.create_index(
        "idx_source_media_processing",
        "source_media",
        ["processing_status", "next_retry_at"],
    )
    op.execute(
        """
        INSERT INTO source_media (source_id, processing_status, processing_version, processing_attempts)
        SELECT id, 'pending', 1, 0
        FROM sources
        WHERE source_type IN ('image', 'video') AND file_path IS NOT NULL
        ON CONFLICT (source_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("idx_source_media_processing", table_name="source_media")
    op.drop_table("source_media")
