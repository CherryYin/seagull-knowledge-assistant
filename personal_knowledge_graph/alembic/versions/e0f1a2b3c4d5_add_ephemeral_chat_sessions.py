"""add ephemeral chat session visibility

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-09-09

"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "e0f1a2b3c4d5"
down_revision: str | None = "d9e0f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column(
            "is_ephemeral",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "is_ephemeral")
