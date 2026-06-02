"""add discovery items

Revision ID: fa2b3c4d5e6f
Revises: fa1b2c3d4e5f
Create Date: 2026-05-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "fa2b3c4d5e6f"
down_revision: Union[str, None] = "fa1b2c3d4e5f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "discovery_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("item_key", sa.String(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("payload", JSONB(), nullable=False),
        sa.Column("status", sa.String(length=30), server_default="recommended", nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("why", JSONB(), nullable=True),
        sa.Column("source_id", sa.String(), nullable=True),
        sa.Column("feedback", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "provider", "item_key", name="uq_discovery_items_user_provider_item"),
    )
    op.create_index("idx_discovery_items_user_status", "discovery_items", ["user_id", "status"])
    op.create_index("idx_discovery_items_provider", "discovery_items", ["provider"])
    op.create_index("idx_discovery_items_score", "discovery_items", ["score"])


def downgrade() -> None:
    op.drop_index("idx_discovery_items_score", table_name="discovery_items")
    op.drop_index("idx_discovery_items_provider", table_name="discovery_items")
    op.drop_index("idx_discovery_items_user_status", table_name="discovery_items")
    op.drop_table("discovery_items")
