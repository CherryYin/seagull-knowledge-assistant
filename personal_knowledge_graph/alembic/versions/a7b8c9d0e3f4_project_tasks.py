"""Reuse calendar reminders for project actions and unscheduled tasks."""

from alembic import op
import sqlalchemy as sa

revision = "a7b8c9d0e3f4"
down_revision = "f6a7b8c9d0e2"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("calendar_reminders", "date", existing_type=sa.String(10), nullable=True)
    op.add_column("calendar_reminders", sa.Column("project_id", sa.String(), nullable=True))
    op.add_column("calendar_reminders", sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key("fk_reminders_project", "calendar_reminders", "projects", ["project_id"], ["id"], ondelete="SET NULL")
    op.create_check_constraint("ck_reminders_recurring_date", "calendar_reminders", "recurrence = 'once' OR date IS NOT NULL")
    op.create_index("idx_calendar_reminders_user_project", "calendar_reminders", ["user_id", "project_id", "is_done"])
    op.add_column("projects", sa.Column("next_reminder_id", sa.String(), nullable=True))
    op.create_foreign_key("fk_projects_next_reminder", "projects", "calendar_reminders", ["next_reminder_id"], ["id"], ondelete="SET NULL")
    op.create_index("idx_projects_next_reminder", "projects", ["next_reminder_id"])


def downgrade():
    if not op.get_context().as_sql:
        count = op.get_bind().execute(sa.text("SELECT count(*) FROM calendar_reminders WHERE date IS NULL")).scalar_one()
        if count:
            raise RuntimeError("Schedule unscheduled tasks before downgrading; dates will not be invented or tasks deleted")
    op.drop_index("idx_projects_next_reminder", table_name="projects")
    op.drop_constraint("fk_projects_next_reminder", "projects", type_="foreignkey")
    op.drop_column("projects", "next_reminder_id")
    op.drop_index("idx_calendar_reminders_user_project", table_name="calendar_reminders")
    op.drop_constraint("ck_reminders_recurring_date", "calendar_reminders", type_="check")
    op.drop_constraint("fk_reminders_project", "calendar_reminders", type_="foreignkey")
    op.drop_column("calendar_reminders", "completed_at")
    op.drop_column("calendar_reminders", "project_id")
    op.alter_column("calendar_reminders", "date", existing_type=sa.String(10), nullable=False)
