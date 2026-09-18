from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class GitHubTrendProfile(Base):
    __tablename__ = "github_trend_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str | None] = mapped_column(String(80))
    schedule: Mapped[str] = mapped_column(String(20), nullable=False, server_default="manual")
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    candidate_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="25")
    top_k: Mapped[int] = mapped_column(Integer, nullable=False, server_default="5")
    last_run_at: Mapped[datetime | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_github_trend_profile_user_name"),
        Index("idx_github_trend_profiles_user_enabled", "user_id", "is_enabled"),
        Index("idx_github_trend_profiles_schedule", "schedule", "last_run_at"),
    )
