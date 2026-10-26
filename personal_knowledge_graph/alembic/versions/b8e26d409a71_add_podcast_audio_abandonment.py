"""Allow explicitly acknowledged abandonment without deleting audio billing history."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "b8e26d409a71"
down_revision = "a37c9e6f402b"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("asset_audio_renders", sa.Column("abandonment", postgresql.JSONB(), nullable=True))
    op.drop_constraint("ck_audio_render_status", "asset_audio_renders", type_="check")
    op.create_check_constraint(
        "ck_audio_render_status", "asset_audio_renders",
        "status IN ('queued', 'generating', 'assembling', 'ready', 'failed', 'canceled', 'outcome_unknown', 'abandoned')",
    )


def downgrade():
    if op.get_context().as_sql:
        raise RuntimeError("Offline downgrade cannot verify retained audio abandonment records")
    count = op.get_bind().execute(sa.text(
        "SELECT count(*) FROM asset_audio_renders WHERE status = 'abandoned' OR abandonment IS NOT NULL"
    )).scalar_one()
    if count:
        raise RuntimeError("Export and explicitly remove abandoned audio records before downgrading")
    op.drop_constraint("ck_audio_render_status", "asset_audio_renders", type_="check")
    op.create_check_constraint(
        "ck_audio_render_status", "asset_audio_renders",
        "status IN ('queued', 'generating', 'assembling', 'ready', 'failed', 'canceled', 'outcome_unknown')",
    )
    op.drop_column("asset_audio_renders", "abandonment")
