"""Persist confirmed Project execution context independently of session links."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("chat_sessions", sa.Column("project_context", JSONB(), nullable=True))


def downgrade():
    if not op.get_context().as_sql:
        count = op.get_bind().execute(sa.text("SELECT count(*) FROM chat_sessions WHERE project_context IS NOT NULL")).scalar_one()
        if count:
            raise RuntimeError("Export and explicitly clear project session contexts before downgrading")
    op.drop_column("chat_sessions", "project_context")
