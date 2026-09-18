"""drop retired Asset memory references

Revision ID: b7c8d9e0f1a3
Revises: b7c8d9e0f1a2
Create Date: 2026-08-22 19:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "b7c8d9e0f1a3"
down_revision: Union[str, None] = "b7c8d9e0f1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("assets", "memory_refs")


def downgrade() -> None:
    op.add_column(
        "assets",
        sa.Column("memory_refs", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
    )
