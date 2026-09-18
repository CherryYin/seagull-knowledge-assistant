"""Initial schema: sources, notes, embeddings

Revision ID: 001
Revises:
Create Date: 2026-04-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = 1024


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # L1: Sources
    op.create_table(
        "sources",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("source_type", sa.String(50), nullable=False),
        sa.Column("url", sa.Text()),
        sa.Column("content_hash", sa.String(64)),
        sa.Column("raw_content", sa.Text()),
        sa.Column("file_path", sa.Text()),
        sa.Column("ingested_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("metadata", JSONB),
    )
    op.create_index("idx_sources_type", "sources", ["source_type"])
    op.create_index("idx_sources_hash", "sources", ["content_hash"])

    # L2: Notes
    op.create_table(
        "notes",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("note_type", sa.String(50), nullable=False),
        sa.Column("domains", ARRAY(sa.Text()), server_default="{}"),
        sa.Column("tags", ARRAY(sa.Text()), server_default="{}"),
        sa.Column("abstract", sa.Text()),
        sa.Column("content", sa.Text()),
        sa.Column("project", sa.String(200)),
        sa.Column("status", sa.String(20), server_default="seed"),
        sa.Column("confidence", sa.String(20), server_default="medium"),
        sa.Column("source_ids", ARRAY(sa.Text()), server_default="{}"),
        sa.Column("file_path", sa.Text()),
        sa.Column("word_count", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("idx_notes_domains", "notes", ["domains"], postgresql_using="gin")
    op.create_index("idx_notes_tags", "notes", ["tags"], postgresql_using="gin")
    op.create_index("idx_notes_sources", "notes", ["source_ids"], postgresql_using="gin")

    # Source embeddings
    op.create_table(
        "source_embeddings",
        sa.Column("source_id", sa.String(), sa.ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("title_vec", Vector(EMBEDDING_DIM)),
        sa.Column("summary_vec", Vector(EMBEDDING_DIM)),
    )

    # Note embeddings
    op.create_table(
        "note_embeddings",
        sa.Column("note_id", sa.String(), sa.ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("abstract_vec", Vector(EMBEDDING_DIM)),
        sa.Column("title_vec", Vector(EMBEDDING_DIM)),
    )

    # HNSW indexes for fast vector search
    op.execute(
        "CREATE INDEX idx_source_emb_title ON source_embeddings "
        "USING hnsw (title_vec vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX idx_source_emb_summary ON source_embeddings "
        "USING hnsw (summary_vec vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX idx_note_emb_abstract ON note_embeddings "
        "USING hnsw (abstract_vec vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX idx_note_emb_title ON note_embeddings "
        "USING hnsw (title_vec vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_table("note_embeddings")
    op.drop_table("source_embeddings")
    op.drop_table("notes")
    op.drop_table("sources")
    op.execute("DROP EXTENSION IF EXISTS vector")
