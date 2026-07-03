"""add user api credentials

Revision ID: fd3e4f5a6b7c
Revises: fc2d3e4f5a6b
Create Date: 2026-06-25 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "fd3e4f5a6b7c"
down_revision = "fc2d3e4f5a6b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_api_credentials",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("label", sa.String(length=100), server_default="default", nullable=False),
        sa.Column("secret_encrypted", sa.Text(), nullable=False),
        sa.Column("secret_masked", sa.String(length=255), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "provider", "label", name="uq_user_api_credentials_user_provider_label"),
    )
    op.create_index("ix_user_api_credentials_user_id", "user_api_credentials", ["user_id"])
    op.create_index("ix_user_api_credentials_provider", "user_api_credentials", ["provider"])
    op.create_index("idx_user_api_credentials_user_provider", "user_api_credentials", ["user_id", "provider"])


def downgrade() -> None:
    op.drop_index("idx_user_api_credentials_user_provider", table_name="user_api_credentials")
    op.drop_index("ix_user_api_credentials_provider", table_name="user_api_credentials")
    op.drop_index("ix_user_api_credentials_user_id", table_name="user_api_credentials")
    op.drop_table("user_api_credentials")
