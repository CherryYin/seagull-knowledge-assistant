from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    asset_type: Mapped[str] = mapped_column(String(50), nullable=False, server_default="blog_post")
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="draft")
    title: Mapped[str] = mapped_column(Text, nullable=False)
    brief: Mapped[str | None] = mapped_column(Text)
    outline: Mapped[str | None] = mapped_column(Text)
    draft_content: Mapped[str | None] = mapped_column(Text)
    reference_notes: Mapped[str | None] = mapped_column(Text)
    editor_feedback: Mapped[str | None] = mapped_column(Text)
    source_refs: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    note_refs: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    wiki_refs: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    export_format: Mapped[str | None] = mapped_column(String(50))
    exported_at: Mapped[datetime | None] = mapped_column()
    published_at: Mapped[datetime | None] = mapped_column()
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_assets_user_id", "user_id"),
        Index("idx_assets_type", "asset_type"),
        Index("idx_assets_status", "status"),
        Index("idx_assets_updated_at", "updated_at"),
    )


class AssetVisual(Base):
    __tablename__ = "asset_visuals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    asset_id: Mapped[str] = mapped_column(String, ForeignKey("assets.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(30), nullable=False, server_default="cover")
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="generating")
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    file_path: Mapped[str | None] = mapped_column(Text)
    provider_request_id: Mapped[str | None] = mapped_column(String(160))
    error_message: Mapped[str | None] = mapped_column(Text)
    processing_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_retry_at: Mapped[datetime | None] = mapped_column()
    started_at: Mapped[datetime | None] = mapped_column()
    completed_at: Mapped[datetime | None] = mapped_column()
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_asset_visuals_asset_id", "asset_id"),
        Index("idx_asset_visuals_user_id", "user_id"),
        Index("idx_asset_visuals_status", "status"),
        Index("idx_asset_visuals_processing", "status", "next_retry_at"),
    )
