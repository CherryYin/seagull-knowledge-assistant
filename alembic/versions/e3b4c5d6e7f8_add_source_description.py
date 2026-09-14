"""add searchable source description

Revision ID: e3b4c5d6e7f8
Revises: e2a3b4c5d6e7
Create Date: 2026-09-14

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "e3b4c5d6e7f8"
down_revision: str | None = "e2a3b4c5d6e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sources", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("sources", "description")
