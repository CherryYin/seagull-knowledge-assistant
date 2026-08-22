"""drop legacy Memory Tree schema

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
Create Date: 2026-08-22 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, None] = "a6b7c8d9e0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table("wiki_page_memories")
    op.drop_table("memory_edges")
    op.drop_table("memory_embeddings")
    op.drop_table("memory_nodes")


def downgrade() -> None:
    raise RuntimeError(
        "Legacy Memory Tree schema retirement is intentionally irreversible; "
        "restore the audited SQL backup before downgrading."
    )
