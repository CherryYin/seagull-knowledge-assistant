"""Add agent_type to agent_profiles

Revision ID: e1f2a3b4c5d6
Revises: d83b2a4e7ffa
Create Date: 2026-05-14 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, None] = "d83b2a4e7ffa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_profiles",
        sa.Column("agent_type", sa.String(length=50), nullable=False, server_default="action"),
    )
    op.create_index("idx_agent_profiles_type", "agent_profiles", ["agent_type"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_agent_profiles_type", table_name="agent_profiles")
    op.drop_column("agent_profiles", "agent_type")
