"""add connector trends

Revision ID: f8a9b0c1d2e3
Revises: f7a8b9c0d1e2
Create Date: 2026-05-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f8a9b0c1d2e3"
down_revision: Union[str, None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "connector_trend_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("trend_date", sa.String(length=10), nullable=False),
        sa.Column("item_key", sa.String(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("source_id", sa.String(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "provider", "trend_date", "item_key", name="uq_connector_trend_day_item"),
    )
    op.create_index("idx_connector_trends_user_provider_date", "connector_trend_items", ["user_id", "provider", "trend_date"])
    op.create_index("idx_connector_trends_item", "connector_trend_items", ["provider", "item_key"])


def downgrade() -> None:
    op.drop_index("idx_connector_trends_item", table_name="connector_trend_items")
    op.drop_index("idx_connector_trends_user_provider_date", table_name="connector_trend_items")
    op.drop_table("connector_trend_items")
