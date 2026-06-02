"""add memory embeddings

Revision ID: e2f3a4b5c6d7
Revises: c1d2e3f4a5b6
Create Date: 2026-05-20 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from pkg.config import settings

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, None] = "c1d2e3f4a5b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = settings.EMBEDDING_DIM


def upgrade() -> None:
    op.create_table(
        "memory_embeddings",
        sa.Column("memory_node_id", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["memory_node_id"], ["memory_nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("memory_node_id"),
    )
    op.execute(f"ALTER TABLE memory_embeddings ADD COLUMN title_vec vector({EMBEDDING_DIM})")
    op.execute(f"ALTER TABLE memory_embeddings ADD COLUMN summary_vec vector({EMBEDDING_DIM})")
    op.execute(f"ALTER TABLE memory_embeddings ADD COLUMN content_vec vector({EMBEDDING_DIM})")
    op.execute(
        "CREATE INDEX idx_memory_embeddings_summary ON memory_embeddings "
        "USING hnsw (summary_vec vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX idx_memory_embeddings_content ON memory_embeddings "
        "USING hnsw (content_vec vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_index("idx_memory_embeddings_content", table_name="memory_embeddings")
    op.drop_index("idx_memory_embeddings_summary", table_name="memory_embeddings")
    op.drop_table("memory_embeddings")
