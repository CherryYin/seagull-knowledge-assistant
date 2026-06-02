"""add wiki pages and source evidence

Revision ID: b9c8d7e6f5a4
Revises: a2b3c4d5e6f7
Create Date: 2026-05-20 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "b9c8d7e6f5a4"
down_revision: Union[str, None] = "a2b3c4d5e6f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = 1024


def upgrade() -> None:
    op.create_table(
        "wiki_pages",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("page_type", sa.String(length=50), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("domains", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("tags", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("derived_from_notes", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("derived_from_sources", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("open_questions", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("confidence_score", sa.Float(), nullable=True),
        sa.Column("needs_recompile", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("last_compiled_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wiki_pages_user_id", "wiki_pages", ["user_id"])
    op.create_index("idx_wiki_pages_type", "wiki_pages", ["page_type"])
    op.create_index("idx_wiki_pages_tags", "wiki_pages", ["tags"], postgresql_using="gin")
    op.create_index("idx_wiki_pages_domains", "wiki_pages", ["domains"], postgresql_using="gin")
    op.create_index(
        "idx_wiki_pages_needs_recompile",
        "wiki_pages",
        ["needs_recompile"],
        postgresql_where=sa.text("needs_recompile IS TRUE"),
    )

    op.create_table(
        "wiki_embeddings",
        sa.Column("wiki_id", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["wiki_id"], ["wiki_pages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("wiki_id"),
    )
    op.execute(f"ALTER TABLE wiki_embeddings ADD COLUMN title_vec vector({EMBEDDING_DIM})")
    op.execute(f"ALTER TABLE wiki_embeddings ADD COLUMN summary_vec vector({EMBEDDING_DIM})")
    op.execute(f"ALTER TABLE wiki_embeddings ADD COLUMN content_vec vector({EMBEDDING_DIM})")
    op.execute(
        "CREATE INDEX idx_wiki_embeddings_summary ON wiki_embeddings "
        "USING hnsw (summary_vec vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX idx_wiki_embeddings_content ON wiki_embeddings "
        "USING hnsw (content_vec vector_cosine_ops)"
    )

    op.create_table(
        "wiki_page_sources",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("wiki_id", sa.String(), nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("relevance_summary", sa.Text(), nullable=False),
        sa.Column("key_points", JSONB(), nullable=True),
        sa.Column("supporting_claims", JSONB(), nullable=True),
        sa.Column("cited_chunk_ids", ARRAY(sa.Integer()), server_default="{}", nullable=False),
        sa.Column("confidence_score", sa.Float(), nullable=True),
        sa.Column("last_refreshed_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["wiki_id"], ["wiki_pages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("wiki_id", "source_id", name="uq_wiki_page_sources_wiki_source"),
    )
    op.create_index("idx_wiki_page_sources_wiki", "wiki_page_sources", ["wiki_id"])
    op.create_index("idx_wiki_page_sources_source", "wiki_page_sources", ["source_id"])


def downgrade() -> None:
    op.drop_index("idx_wiki_page_sources_source", table_name="wiki_page_sources")
    op.drop_index("idx_wiki_page_sources_wiki", table_name="wiki_page_sources")
    op.drop_table("wiki_page_sources")
    op.drop_index("idx_wiki_embeddings_content", table_name="wiki_embeddings")
    op.drop_index("idx_wiki_embeddings_summary", table_name="wiki_embeddings")
    op.drop_table("wiki_embeddings")
    op.drop_index("idx_wiki_pages_needs_recompile", table_name="wiki_pages")
    op.drop_index("idx_wiki_pages_domains", table_name="wiki_pages")
    op.drop_index("idx_wiki_pages_tags", table_name="wiki_pages")
    op.drop_index("idx_wiki_pages_type", table_name="wiki_pages")
    op.drop_index("idx_wiki_pages_user_id", table_name="wiki_pages")
    op.drop_table("wiki_pages")
