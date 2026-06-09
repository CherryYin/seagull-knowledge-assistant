from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class PaperDiscoveryProfile(Base):
    __tablename__ = "paper_discovery_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    goal_prompt: Mapped[str | None] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, server_default="query")
    provider: Mapped[str] = mapped_column(String(50), nullable=False, server_default="openalex")
    schedule: Mapped[str] = mapped_column(String(20), nullable=False, server_default="manual")
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    max_results: Mapped[int] = mapped_column(Integer, nullable=False, server_default="20")
    discovery_window_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default="365")
    time_window_days: Mapped[int | None] = mapped_column(Integer)
    include_terms: Mapped[list | None] = mapped_column(JSONB)
    exclude_terms: Mapped[list | None] = mapped_column(JSONB)
    preferred_authors: Mapped[list | None] = mapped_column(JSONB)
    preferred_venues: Mapped[list | None] = mapped_column(JSONB)
    preferred_fields: Mapped[list | None] = mapped_column(JSONB)
    preferred_arxiv_categories: Mapped[list | None] = mapped_column(JSONB)
    seed_paper_ids: Mapped[list | None] = mapped_column(JSONB)
    last_run_at: Mapped[datetime | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_paper_discovery_profile_user_name"),
        Index("idx_paper_discovery_profiles_user_enabled", "user_id", "is_enabled"),
        Index("idx_paper_discovery_profiles_provider", "provider"),
    )


class PaperDiscoveryRun(Base):
    __tablename__ = "paper_discovery_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(Integer, ForeignKey("paper_discovery_profiles.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="pending")
    query_bundle: Mapped[dict | None] = mapped_column(JSONB)
    stats: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column()

    __table_args__ = (
        Index("idx_paper_discovery_runs_profile_started", "profile_id", "started_at"),
        Index("idx_paper_discovery_runs_user_status", "user_id", "status"),
    )


class PaperTrendSnapshot(Base):
    __tablename__ = "paper_trend_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    profile_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("paper_discovery_profiles.id"))
    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    scope_key: Mapped[str] = mapped_column(String(255), nullable=False)
    window_start: Mapped[datetime] = mapped_column(nullable=False)
    window_end: Mapped[datetime] = mapped_column(nullable=False)
    topic: Mapped[str | None] = mapped_column(String(255))
    term: Mapped[str] = mapped_column(String(255), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False)
    baseline_count: Mapped[int | None] = mapped_column(Integer)
    growth_rate: Mapped[float | None] = mapped_column(Float)
    score: Mapped[float | None] = mapped_column(Float)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "provider",
            "scope_key",
            "window_start",
            "window_end",
            "term",
            name="uq_paper_trend_snapshot_window_term",
        ),
        Index("idx_paper_trend_snapshots_user_created", "user_id", "created_at"),
        Index("idx_paper_trend_snapshots_profile_window", "profile_id", "window_end"),
    )
