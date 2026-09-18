"""KnowledgeStats — tracks how often each Note/Source is searched, retrieved, and referenced."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, PrimaryKeyConstraint, String, func
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class KnowledgeStats(Base):
    __tablename__ = "knowledge_stats"
    __table_args__ = (
        PrimaryKeyConstraint("item_id", "item_type"),
    )

    item_id: Mapped[str] = mapped_column(String, nullable=False)
    item_type: Mapped[str] = mapped_column(String(10), nullable=False)  # "note" | "source"

    search_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    retrieval_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    reference_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)

    last_accessed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
