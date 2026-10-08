"""add asset visuals

Revision ID: d4e5f6a7b8c0
Revises: c3d4e5f6a7b9
Create Date: 2026-10-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "d4e5f6a7b8c0"
down_revision = "c3d4e5f6a7b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "asset_visuals",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("asset_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(length=30), server_default="cover", nullable=False),
        sa.Column("status", sa.String(length=30), server_default="generating", nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("mime_type", sa.String(length=120), nullable=True),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("provider_request_id", sa.String(length=160), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_asset_visuals_asset_id", "asset_visuals", ["asset_id"])
    op.create_index("idx_asset_visuals_user_id", "asset_visuals", ["user_id"])
    op.create_index("idx_asset_visuals_status", "asset_visuals", ["status"])


def downgrade() -> None:
    op.drop_index("idx_asset_visuals_status", table_name="asset_visuals")
    op.drop_index("idx_asset_visuals_user_id", table_name="asset_visuals")
    op.drop_index("idx_asset_visuals_asset_id", table_name="asset_visuals")
    op.drop_table("asset_visuals")
