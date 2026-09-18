"""add assets

Revision ID: fb1c2d3e4f5a
Revises: fa4b5c6d7e8f
Create Date: 2026-06-08 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "fb1c2d3e4f5a"
down_revision: Union[str, None] = "fa4b5c6d7e8f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "assets",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("asset_type", sa.String(length=50), server_default="blog_post", nullable=False),
        sa.Column("status", sa.String(length=30), server_default="draft", nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("brief", sa.Text(), nullable=True),
        sa.Column("outline", sa.Text(), nullable=True),
        sa.Column("draft_content", sa.Text(), nullable=True),
        sa.Column("reference_notes", sa.Text(), nullable=True),
        sa.Column("editor_feedback", sa.Text(), nullable=True),
        sa.Column("source_refs", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("note_refs", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("memory_refs", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("wiki_refs", ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("export_format", sa.String(length=50), nullable=True),
        sa.Column("exported_at", sa.DateTime(), nullable=True),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_assets_user_id", "assets", ["user_id"])
    op.create_index("idx_assets_type", "assets", ["asset_type"])
    op.create_index("idx_assets_status", "assets", ["status"])
    op.create_index("idx_assets_updated_at", "assets", ["updated_at"])


def downgrade() -> None:
    op.drop_index("idx_assets_updated_at", table_name="assets")
    op.drop_index("idx_assets_status", table_name="assets")
    op.drop_index("idx_assets_type", table_name="assets")
    op.drop_index("idx_assets_user_id", table_name="assets")
    op.drop_table("assets")
