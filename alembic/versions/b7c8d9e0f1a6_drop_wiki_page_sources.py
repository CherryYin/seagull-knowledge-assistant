"""drop duplicate wiki page source provenance

Revision ID: b7c8d9e0f1a6
Revises: b7c8d9e0f1a5
Create Date: 2026-08-22

"""

from collections.abc import Sequence

from alembic import op


revision: str = "b7c8d9e0f1a6"
down_revision: str | None = "b7c8d9e0f1a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("wiki_page_sources")


def downgrade() -> None:
    raise RuntimeError(
        "Wiki provenance retirement is irreversible; restore from a database backup if needed"
    )
