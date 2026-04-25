"""add users and user feature tables

Revision ID: c8d9e0f1a2b3
Revises: a1b2c3d4e5f6
Create Date: 2026-04-15 00:00:00.000000

"""
import os
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create users table
    op.create_table(
        "users",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("username", sa.String(100), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("hashed_password", sa.Text(), nullable=False),
        sa.Column("role", sa.String(20), server_default="user", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username"),
    )

    # 2. Seed default admin user
    from bcrypt import hashpw, gensalt

    admin_password = os.environ.get("ADMIN_INIT_PASSWORD", "admin123")
    hashed = hashpw(admin_password.encode(), gensalt()).decode()
    admin_id = str(uuid.uuid4())
    op.execute(
        sa.text(
            "INSERT INTO users (id, username, display_name, hashed_password, role) "
            "VALUES (:id, :username, :display_name, :hashed_password, :role)"
        ).bindparams(
            id=admin_id,
            username="admin",
            display_name="Admin",
            hashed_password=hashed,
            role="admin",
        )
    )

    # 3. Add user_id to existing tables (nullable first, then backfill, then NOT NULL)
    for table in ("notes", "sources", "chat_sessions"):
        op.add_column(table, sa.Column("user_id", sa.String(), nullable=True))
        op.execute(sa.text(f"UPDATE {table} SET user_id = :uid").bindparams(uid=admin_id))
        op.alter_column(table, "user_id", nullable=False)
        op.create_foreign_key(f"fk_{table}_user_id", table, "users", ["user_id"], ["id"])
        op.create_index(f"idx_{table}_user_id", table, ["user_id"])

    # 4. Add is_shared to sources
    op.add_column("sources", sa.Column("is_shared", sa.Boolean(), server_default="false", nullable=False))

    # 5. Create user_memories table
    op.create_table(
        "user_memories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("key", sa.String(200), nullable=False),
        sa.Column("value", sa.dialects.postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "key", name="uq_user_memories_user_key"),
    )
    op.create_index("idx_user_memories_user_id", "user_memories", ["user_id"])

    # 6. Create user_settings table
    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("settings", sa.dialects.postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("user_id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )

    # 7. Create activity_logs table
    op.create_table(
        "activity_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("detail", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_activity_logs_user_id", "activity_logs", ["user_id"])


def downgrade() -> None:
    op.drop_table("activity_logs")
    op.drop_table("user_settings")
    op.drop_table("user_memories")

    op.drop_column("sources", "is_shared")

    for table in ("chat_sessions", "sources", "notes"):
        op.drop_index(f"idx_{table}_user_id", table_name=table)
        op.drop_constraint(f"fk_{table}_user_id", table, type_="foreignkey")
        op.drop_column(table, "user_id")

    op.drop_table("users")
