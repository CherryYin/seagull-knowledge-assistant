"""add resumable video transcript segments

Revision ID: a1b2c3d4e5f7
Revises: e6f7a8b9c0d1
Create Date: 2026-09-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

from pkg.config import settings

revision: str = "a1b2c3d4e5f7"
down_revision: str | None = "e6f7a8b9c0d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("source_media", sa.Column("transcript", sa.Text(), nullable=True))
    op.add_column("source_media", sa.Column("transcript_model", sa.String(length=200), nullable=True))
    op.add_column(
        "source_media",
        sa.Column("transcript_status", sa.String(length=30), server_default="pending", nullable=False),
    )
    op.add_column(
        "source_media",
        sa.Column("segment_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "source_media",
        sa.Column("processing_stage", sa.String(length=30), server_default="queued", nullable=False),
    )
    op.execute(
        "UPDATE source_media SET transcript_status = 'not_applicable' "
        "WHERE source_id IN (SELECT id FROM sources WHERE source_type <> 'video')"
    )
    op.execute(
        "UPDATE source_media SET processing_status = 'pending', processing_stage = 'caption', "
        "processing_attempts = 0, next_retry_at = NULL, error_message = NULL "
        "WHERE source_id IN (SELECT id FROM sources WHERE source_type = 'video')"
    )
    op.create_table(
        "source_media_segments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("segment_index", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column("thumbnail_path", sa.Text(), nullable=True),
        sa.Column("embedding", Vector(settings.EMBEDDING_DIM), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_id", "segment_index", name="uq_source_media_segment_index"),
    )
    op.create_index(
        "idx_source_media_segments_source_time",
        "source_media_segments",
        ["source_id", "start_ms"],
    )


def downgrade() -> None:
    op.drop_index("idx_source_media_segments_source_time", table_name="source_media_segments")
    op.drop_table("source_media_segments")
    op.drop_column("source_media", "processing_stage")
    op.drop_column("source_media", "segment_count")
    op.drop_column("source_media", "transcript_status")
    op.drop_column("source_media", "transcript_model")
    op.drop_column("source_media", "transcript")
