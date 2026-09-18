"""add source_chunks table

Revision ID: b7c3e1f24a01
Revises: d6ab1d228476
Create Date: 2026-04-10 15:38:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b7c3e1f24a01"
down_revision: Union[str, None] = "d6ab1d228476"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "source_chunks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_source_chunks_source", "source_chunks", ["source_id"])

    # Add vector column via raw SQL (pgvector type)
    op.execute("ALTER TABLE source_chunks ADD COLUMN embedding vector(1024)")

    # HNSW index for fast cosine similarity search
    op.execute(
        "CREATE INDEX idx_source_chunks_embedding ON source_chunks "
        "USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_table("source_chunks")
