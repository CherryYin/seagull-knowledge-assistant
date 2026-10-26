"""Store owner-scoped read-only WeChat statistics snapshots."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "c7f3a2198d62"
down_revision = "b8e26d409a71"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "wechat_statistics_snapshots",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("credential_id", sa.Integer(), sa.ForeignKey("user_api_credentials.id", ondelete="CASCADE"), nullable=False),
        sa.Column("account_hash", sa.String(64), nullable=False),
        sa.Column("publication_date", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_wechat_stats_scope", "wechat_statistics_snapshots", ["user_id", "credential_id", "account_hash", "publication_date", "fetched_at"])


def downgrade():
    op.drop_table("wechat_statistics_snapshots")
