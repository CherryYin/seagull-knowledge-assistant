"""add user scope to system jobs

Revision ID: fa4b5c6d7e8f
Revises: fa3b4c5d6e7f
Create Date: 2026-06-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "fa4b5c6d7e8f"
down_revision: Union[str, None] = "fa3b4c5d6e7f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("system_jobs", sa.Column("user_id", sa.String(), nullable=True))
    op.create_foreign_key("fk_system_jobs_user_id", "system_jobs", "users", ["user_id"], ["id"])
    op.create_index("idx_system_jobs_user_id", "system_jobs", ["user_id"])


def downgrade() -> None:
    op.drop_index("idx_system_jobs_user_id", table_name="system_jobs")
    op.drop_constraint("fk_system_jobs_user_id", "system_jobs", type_="foreignkey")
    op.drop_column("system_jobs", "user_id")
