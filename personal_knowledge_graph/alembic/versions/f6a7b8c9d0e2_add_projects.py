"""Add user-owned Projects and references to existing resources."""

from alembic import op
import sqlalchemy as sa


revision = "f6a7b8c9d0e2"
down_revision = "e5f6a7b8c9d1"
branch_labels = None
depends_on = None

TARGETS = {
    "source": ("source_id", "sources"), "note": ("note_id", "notes"),
    "wiki": ("wiki_id", "wiki_pages"), "asset": ("asset_id", "assets"),
    "chat_session": ("chat_session_id", "chat_sessions"),
}


def upgrade():
    op.create_table("projects",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("completion_criteria", sa.Text(), server_default="", nullable=False),
        sa.Column("status", sa.String(20), server_default="active", nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('active', 'completed')", name="ck_projects_status"),
        sa.CheckConstraint("revision >= 1", name="ck_projects_revision"))
    op.create_index("idx_projects_user_updated", "projects", ["user_id", "updated_at"])
    check = " OR ".join("(resource_type = '{}' AND {})".format(kind,
        " AND ".join(f"{column} IS {'NOT ' if column == selected else ''}NULL"
                     for column, _table in TARGETS.values())) for kind, (selected, _table) in TARGETS.items())
    op.create_table("project_resources",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("resource_type", sa.String(20), nullable=False),
        *(sa.Column(column, sa.String(), sa.ForeignKey(f"{table}.id", ondelete="CASCADE"))
          for column, table in TARGETS.values()),
        sa.Column("reason", sa.Text(), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(check, name="ck_project_resources_target"),
        *(sa.UniqueConstraint("project_id", column, name=f"uq_project_resources_{kind}")
          for kind, (column, _table) in TARGETS.items()))
    op.create_index("idx_project_resources_project_type", "project_resources", ["project_id", "resource_type"])
    for kind, (column, _table) in TARGETS.items():
        op.create_index(f"idx_project_resources_{kind}", "project_resources", [column])


def downgrade():
    op.drop_table("project_resources")
    op.drop_table("projects")
