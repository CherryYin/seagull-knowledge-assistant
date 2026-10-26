"""Add versioned podcast configuration and audio task foundations."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "asset_podcast_configs",
        sa.Column("asset_id", sa.String(), nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("provider", sa.String(length=40), server_default="qwen", nullable=False),
        sa.Column("region", sa.String(length=40), server_default="cn-beijing", nullable=False),
        sa.Column("model", sa.String(length=120), server_default="qwen3-tts-flash", nullable=False),
        sa.Column("voice_id", sa.String(length=120), server_default="Cherry", nullable=False),
        sa.Column("target_duration_minutes", sa.Integer(), server_default="6", nullable=False),
        sa.Column("information_cutoff_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("revision >= 1", name="ck_podcast_config_revision"),
        sa.CheckConstraint(
            "target_duration_minutes BETWEEN 1 AND 30", name="ck_podcast_config_duration"
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("asset_id"),
    )
    op.create_table(
        "asset_podcast_script_approvals",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("asset_id", sa.String(), nullable=False),
        sa.Column("config_revision", sa.Integer(), nullable=False),
        sa.Column("script_hash", sa.String(length=64), nullable=False),
        sa.Column("input_hash", sa.String(length=64), nullable=False),
        sa.Column("spoken_text", sa.Text(), nullable=False),
        sa.Column("source_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("config_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("approved_by", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("config_revision >= 1", name="ck_podcast_approval_revision"),
        sa.ForeignKeyConstraint(
            ["approved_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("asset_id", "id", name="uq_podcast_approval_asset_id"),
    )
    op.create_index(
        "idx_podcast_approvals_asset",
        "asset_podcast_script_approvals",
        ["asset_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "asset_audio_renders",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("asset_id", sa.String(), nullable=False),
        sa.Column("script_approval_id", sa.String(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("input_hash", sa.String(length=64), nullable=False),
        sa.Column("config_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=30), server_default="queued", nullable=False),
        sa.Column("budget_limit", sa.Numeric(precision=12, scale=4), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="CNY", nullable=False),
        sa.Column("lease_token", sa.String(length=120), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("file_sha256", sa.String(length=64), nullable=True),
        sa.Column("duration_seconds", sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'generating', 'assembling', 'ready', 'failed', 'canceled', 'outcome_unknown')",
            name="ck_audio_render_status",
        ),
        sa.CheckConstraint("budget_limit >= 0", name="ck_audio_render_budget"),
        sa.CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds > 0", name="ck_audio_render_duration"
        ),
        sa.ForeignKeyConstraint(
            ["asset_id", "script_approval_id"],
            ["asset_podcast_script_approvals.asset_id", "asset_podcast_script_approvals.id"],
            name="fk_audio_render_approval_asset",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("asset_id", "idempotency_key", name="uq_audio_render_idempotency"),
    )
    op.create_index(
        "idx_audio_render_processing",
        "asset_audio_renders",
        ["status", "lease_expires_at"],
        unique=False,
    )
    op.create_index(
        "uq_audio_render_active_asset",
        "asset_audio_renders",
        ["asset_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('queued', 'generating', 'assembling', 'outcome_unknown')"
        ),
    )
    op.create_table(
        "asset_audio_segments",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("render_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("spoken_text", sa.Text(), nullable=False),
        sa.Column("input_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=30), server_default="queued", nullable=False),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("file_sha256", sa.String(length=64), nullable=True),
        sa.Column("duration_seconds", sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'generating', 'ready', 'failed', 'canceled', 'outcome_unknown')",
            name="ck_audio_segment_status",
        ),
        sa.CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds > 0", name="ck_audio_segment_duration"
        ),
        sa.CheckConstraint("position >= 0", name="ck_audio_segment_position"),
        sa.ForeignKeyConstraint(["render_id"], ["asset_audio_renders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("render_id", "id", name="uq_audio_segment_render_id"),
        sa.UniqueConstraint("render_id", "position", name="uq_audio_segment_position"),
    )
    op.create_table(
        "asset_audio_attempts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("render_id", sa.String(), nullable=False),
        sa.Column("segment_id", sa.String(), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=30), server_default="started", nullable=False),
        sa.Column("provider_request_id", sa.String(length=160), nullable=True),
        sa.Column("billable_characters", sa.Integer(), nullable=True),
        sa.Column("reported_cost", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("currency", sa.String(length=3), server_default="CNY", nullable=False),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('started', 'succeeded', 'failed', 'outcome_unknown')",
            name="ck_audio_attempt_status",
        ),
        sa.CheckConstraint("attempt_number >= 1", name="ck_audio_attempt_number"),
        sa.CheckConstraint(
            "billable_characters IS NULL OR billable_characters >= 0",
            name="ck_audio_attempt_characters",
        ),
        sa.CheckConstraint(
            "reported_cost IS NULL OR reported_cost >= 0", name="ck_audio_attempt_cost"
        ),
        sa.ForeignKeyConstraint(
            ["render_id", "segment_id"],
            ["asset_audio_segments.render_id", "asset_audio_segments.id"],
            name="fk_audio_attempt_segment_render",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("segment_id", "attempt_number", name="uq_audio_attempt_number"),
    )


def downgrade():
    tables = [
        "asset_audio_attempts",
        "asset_audio_segments",
        "asset_audio_renders",
        "asset_podcast_script_approvals",
        "asset_podcast_configs",
    ]
    if not op.get_context().as_sql:
        for table in tables:
            count = op.get_bind().execute(sa.text(f'SELECT count(*) FROM "{table}"')).scalar_one()
            if count:
                raise RuntimeError("Export and explicitly remove podcast data before downgrading")
    for table in tables:
        op.drop_table(table)
