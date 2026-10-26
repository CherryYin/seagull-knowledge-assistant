"""Preserve sanitized Podcast audio failure diagnostics."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "a37c9e6f402b"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("asset_audio_renders", sa.Column("failure_details", postgresql.JSONB(), nullable=True))
    op.add_column("asset_audio_attempts", sa.Column("failure_details", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("asset_audio_attempts", "failure_details")
    op.drop_column("asset_audio_renders", "failure_details")
