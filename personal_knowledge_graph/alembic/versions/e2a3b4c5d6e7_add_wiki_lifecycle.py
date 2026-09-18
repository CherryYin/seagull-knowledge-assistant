"""add formal wiki lifecycle fields

Revision ID: e2a3b4c5d6e7
Revises: e14f9c2a7b6d
Create Date: 2026-09-14

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "e2a3b4c5d6e7"
down_revision: str | None = "e14f9c2a7b6d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "wiki_pages",
        sa.Column("lifecycle_status", sa.String(length=20), server_default="stable", nullable=False),
    )
    op.add_column(
        "wiki_pages",
        sa.Column("content_revision", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column("wiki_pages", sa.Column("stable_at", sa.DateTime(), nullable=True))
    op.add_column("wiki_pages", sa.Column("stable_revision", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE wiki_pages
        SET lifecycle_status = CASE
                WHEN tags @> ARRAY['wiki-draft']::text[] THEN 'draft'
                ELSE 'stable'
            END,
            stable_at = CASE
                WHEN tags @> ARRAY['wiki-draft']::text[] THEN NULL
                ELSE updated_at
            END,
            stable_revision = CASE
                WHEN tags @> ARRAY['wiki-draft']::text[] THEN NULL
                ELSE 1
            END
        """
    )
    op.create_check_constraint(
        "ck_wiki_pages_lifecycle_status",
        "wiki_pages",
        "lifecycle_status IN ('draft', 'stable', 'archived')",
    )
    op.create_index("idx_wiki_pages_lifecycle_status", "wiki_pages", ["lifecycle_status"])


def downgrade() -> None:
    op.drop_index("idx_wiki_pages_lifecycle_status", table_name="wiki_pages")
    op.drop_constraint("ck_wiki_pages_lifecycle_status", "wiki_pages", type_="check")
    op.drop_column("wiki_pages", "stable_revision")
    op.drop_column("wiki_pages", "stable_at")
    op.drop_column("wiki_pages", "content_revision")
    op.drop_column("wiki_pages", "lifecycle_status")
