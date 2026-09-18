"""add categories table and category_id to notes and sources

Revision ID: a1b2c3d4e5f6
Revises: b7c3e1f24a01
Create Date: 2026-04-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "b7c3e1f24a01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create categories table
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )

    # 2. Insert default "general" category
    op.execute(
        "INSERT INTO categories (name, display_name, description) "
        "VALUES ('general', 'General', 'Default category')"
    )

    # 3. Add category_id to notes (nullable first, then backfill, then NOT NULL)
    op.add_column("notes", sa.Column("category_id", sa.Integer(), nullable=True))
    op.execute(
        "UPDATE notes SET category_id = (SELECT id FROM categories WHERE name = 'general')"
    )
    op.alter_column("notes", "category_id", nullable=False)
    op.create_foreign_key("fk_notes_category_id", "notes", "categories", ["category_id"], ["id"])
    op.create_index("idx_notes_category", "notes", ["category_id"])

    # 4. Add category_id to sources (same pattern)
    op.add_column("sources", sa.Column("category_id", sa.Integer(), nullable=True))
    op.execute(
        "UPDATE sources SET category_id = (SELECT id FROM categories WHERE name = 'general')"
    )
    op.alter_column("sources", "category_id", nullable=False)
    op.create_foreign_key("fk_sources_category_id", "sources", "categories", ["category_id"], ["id"])
    op.create_index("idx_sources_category", "sources", ["category_id"])


def downgrade() -> None:
    op.drop_index("idx_sources_category", table_name="sources")
    op.drop_constraint("fk_sources_category_id", "sources", type_="foreignkey")
    op.drop_column("sources", "category_id")

    op.drop_index("idx_notes_category", table_name="notes")
    op.drop_constraint("fk_notes_category_id", "notes", type_="foreignkey")
    op.drop_column("notes", "category_id")

    op.drop_table("categories")
