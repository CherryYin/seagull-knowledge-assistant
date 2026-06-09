from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class ReviewSuggestion(Base):
    __tablename__ = "review_suggestions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    suggestion_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    proposed_value: Mapped[dict | None] = mapped_column(JSONB)
    evidence: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="pending")
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    reviewed_at: Mapped[datetime | None] = mapped_column()
    applied_at: Mapped[datetime | None] = mapped_column()
    reviewer_note: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "suggestion_type",
            "target_type",
            "target_id",
            "status",
            name="uq_review_suggestions_open_target",
        ),
        Index("idx_review_suggestions_user", "user_id"),
        Index("idx_review_suggestions_type", "suggestion_type"),
        Index("idx_review_suggestions_status", "status"),
        Index("idx_review_suggestions_target", "target_type", "target_id"),
    )
