"""Attach explicit context and results to existing Todos."""

from alembic import op
import sqlalchemy as sa

revision = "b8c9d0e1f2a3"
down_revision = "a7b8c9d0e3f4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("todo_resources",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("reminder_id", sa.String(), sa.ForeignKey("calendar_reminders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("resource_type", sa.String(20), nullable=False),
        sa.Column("source_id", sa.String(), sa.ForeignKey("sources.id", ondelete="CASCADE")),
        sa.Column("note_id", sa.String(), sa.ForeignKey("notes.id", ondelete="CASCADE")),
        sa.Column("asset_id", sa.String(), sa.ForeignKey("assets.id", ondelete="CASCADE")),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("role IN ('context', 'result')", name="ck_todo_resources_role"),
        sa.CheckConstraint("(resource_type = 'source' AND source_id IS NOT NULL AND note_id IS NULL AND asset_id IS NULL) OR "
            "(resource_type = 'note' AND note_id IS NOT NULL AND source_id IS NULL AND asset_id IS NULL) OR "
            "(resource_type = 'asset' AND asset_id IS NOT NULL AND source_id IS NULL AND note_id IS NULL)", name="ck_todo_resources_target"),
        sa.CheckConstraint("role != 'result' OR resource_type IN ('note', 'asset')", name="ck_todo_resources_result"),
        *(sa.UniqueConstraint("reminder_id", "role", f"{kind}_id", name=f"uq_todo_resources_{kind}")
          for kind in ["source", "note", "asset"]),
    )
    for kind in ["source", "note", "asset"]:
        op.create_index(f"idx_todo_resources_{kind}", "todo_resources", [f"{kind}_id"])
    op.create_index("idx_todo_resources_reminder_role", "todo_resources", ["reminder_id", "role"])


def downgrade():
    if not op.get_context().as_sql:
        count = op.get_bind().execute(sa.text("SELECT count(*) FROM todo_resources")).scalar_one()
        if count:
            raise RuntimeError("Remove task resource links explicitly before downgrading; associations will not be silently discarded")
    op.drop_table("todo_resources")
