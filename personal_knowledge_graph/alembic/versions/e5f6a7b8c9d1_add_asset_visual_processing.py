"""add asset visual processing fields

Revision ID: e5f6a7b8c9d1
Revises: d4e5f6a7b8c0
Create Date: 2026-10-08
"""

from alembic import op
import sqlalchemy as sa


revision = "e5f6a7b8c9d1"
down_revision = "d4e5f6a7b8c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("asset_visuals", sa.Column("processing_attempts", sa.Integer(), server_default="0", nullable=False))
    op.add_column("asset_visuals", sa.Column("next_retry_at", sa.DateTime(), nullable=True))
    op.add_column("asset_visuals", sa.Column("started_at", sa.DateTime(), nullable=True))
    op.add_column("asset_visuals", sa.Column("completed_at", sa.DateTime(), nullable=True))
    op.create_index("idx_asset_visuals_processing", "asset_visuals", ["status", "next_retry_at"])


def downgrade() -> None:
    op.drop_index("idx_asset_visuals_processing", table_name="asset_visuals")
    op.drop_column("asset_visuals", "completed_at")
    op.drop_column("asset_visuals", "started_at")
    op.drop_column("asset_visuals", "next_retry_at")
    op.drop_column("asset_visuals", "processing_attempts")
