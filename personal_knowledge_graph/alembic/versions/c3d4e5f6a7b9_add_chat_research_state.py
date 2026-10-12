"""add durable research state to chat sessions

Revision ID: c3d4e5f6a7b9
Revises: b2c3d4e5f6a8
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "c3d4e5f6a7b9"
down_revision: str | None = "b2c3d4e5f6a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("research_state", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_sessions", "research_state")
