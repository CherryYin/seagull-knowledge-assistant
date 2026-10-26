from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class PodcastConfig(Base):
    __tablename__ = "asset_podcast_configs"

    asset_id: Mapped[str] = mapped_column(
        String, ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    provider: Mapped[str] = mapped_column(String(40), nullable=False, server_default="qwen")
    region: Mapped[str] = mapped_column(String(40), nullable=False, server_default="cn-beijing")
    model: Mapped[str] = mapped_column(
        String(120), nullable=False, server_default="qwen3-tts-flash"
    )
    voice_id: Mapped[str] = mapped_column(String(120), nullable=False, server_default="Cherry")
    target_duration_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="6"
    )
    information_cutoff_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_podcast_config_revision"),
        CheckConstraint(
            "target_duration_minutes BETWEEN 1 AND 30", name="ck_podcast_config_duration"
        ),
    )


class PodcastScriptApproval(Base):
    __tablename__ = "asset_podcast_script_approvals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    asset_id: Mapped[str] = mapped_column(
        String, ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    config_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    script_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    spoken_text: Mapped[str] = mapped_column(Text, nullable=False)
    source_snapshot: Mapped[list[dict]] = mapped_column(JSONB, nullable=False)
    config_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    approved_by: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("asset_id", "id", name="uq_podcast_approval_asset_id"),
        CheckConstraint("config_revision >= 1", name="ck_podcast_approval_revision"),
        Index("idx_podcast_approvals_asset", "asset_id", "created_at"),
    )


class AssetAudioRender(Base):
    __tablename__ = "asset_audio_renders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    asset_id: Mapped[str] = mapped_column(
        String, ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    script_approval_id: Mapped[str] = mapped_column(String, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(120), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    config_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="queued")
    budget_limit: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="CNY")
    lease_token: Mapped[str | None] = mapped_column(String(120))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    file_path: Mapped[str | None] = mapped_column(Text)
    file_sha256: Mapped[str | None] = mapped_column(String(64))
    duration_seconds: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    error_message: Mapped[str | None] = mapped_column(Text)
    failure_details: Mapped[dict | None] = mapped_column(JSONB)
    abandonment: Mapped[dict | None] = mapped_column(JSONB)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["asset_id", "script_approval_id"],
            ["asset_podcast_script_approvals.asset_id", "asset_podcast_script_approvals.id"],
            ondelete="CASCADE",
            name="fk_audio_render_approval_asset",
        ),
        UniqueConstraint("asset_id", "idempotency_key", name="uq_audio_render_idempotency"),
        CheckConstraint(
            "status IN ('queued', 'generating', 'assembling', 'ready', 'failed', 'canceled', 'outcome_unknown', 'abandoned')",
            name="ck_audio_render_status",
        ),
        CheckConstraint("budget_limit >= 0", name="ck_audio_render_budget"),
        CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds > 0", name="ck_audio_render_duration"
        ),
        Index(
            "uq_audio_render_active_asset",
            "asset_id",
            unique=True,
            postgresql_where=text(
                "status IN ('queued', 'generating', 'assembling', 'outcome_unknown')"
            ),
        ),
        Index("idx_audio_render_processing", "status", "lease_expires_at"),
    )


class AssetAudioSegment(Base):
    __tablename__ = "asset_audio_segments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    render_id: Mapped[str] = mapped_column(
        String, ForeignKey("asset_audio_renders.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    spoken_text: Mapped[str] = mapped_column(Text, nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="queued")
    file_path: Mapped[str | None] = mapped_column(Text)
    file_sha256: Mapped[str | None] = mapped_column(String(64))
    duration_seconds: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("render_id", "position", name="uq_audio_segment_position"),
        UniqueConstraint("render_id", "id", name="uq_audio_segment_render_id"),
        CheckConstraint("position >= 0", name="ck_audio_segment_position"),
        CheckConstraint(
            "status IN ('queued', 'generating', 'ready', 'failed', 'canceled', 'outcome_unknown')",
            name="ck_audio_segment_status",
        ),
        CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds > 0", name="ck_audio_segment_duration"
        ),
    )


class AssetAudioAttempt(Base):
    __tablename__ = "asset_audio_attempts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    render_id: Mapped[str] = mapped_column(String, nullable=False)
    segment_id: Mapped[str] = mapped_column(String, nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="started")
    provider_request_id: Mapped[str | None] = mapped_column(String(160))
    billable_characters: Mapped[int | None] = mapped_column(Integer)
    reported_cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="CNY")
    error_code: Mapped[str | None] = mapped_column(String(80))
    failure_details: Mapped[dict | None] = mapped_column(JSONB)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        ForeignKeyConstraint(
            ["render_id", "segment_id"],
            ["asset_audio_segments.render_id", "asset_audio_segments.id"],
            ondelete="CASCADE",
            name="fk_audio_attempt_segment_render",
        ),
        UniqueConstraint("segment_id", "attempt_number", name="uq_audio_attempt_number"),
        CheckConstraint("attempt_number >= 1", name="ck_audio_attempt_number"),
        CheckConstraint(
            "status IN ('started', 'succeeded', 'failed', 'outcome_unknown')",
            name="ck_audio_attempt_status",
        ),
        CheckConstraint(
            "billable_characters IS NULL OR billable_characters >= 0",
            name="ck_audio_attempt_characters",
        ),
        CheckConstraint(
            "reported_cost IS NULL OR reported_cost >= 0", name="ck_audio_attempt_cost"
        ),
    )
