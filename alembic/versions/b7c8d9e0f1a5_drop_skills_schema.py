"""drop skills schema

Revision ID: b7c8d9e0f1a5
Revises: b7c8d9e0f1a4
Create Date: 2026-08-22

"""

from collections.abc import Sequence

from alembic import op


revision: str = "b7c8d9e0f1a5"
down_revision: str | None = "b7c8d9e0f1a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("skills")


def downgrade() -> None:
    raise RuntimeError(
        "Skills retirement is irreversible; restore from the SQL backup if needed"
    )
