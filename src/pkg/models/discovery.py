from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class DiscoveryItem(Base):
    __tablename__ = "discovery_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    item_key: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="recommended")
    score: Mapped[float | None] = mapped_column(Float)
    why: Mapped[list | None] = mapped_column(JSONB)
    source_id: Mapped[str | None] = mapped_column(String)
    feedback: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    reviewed_at: Mapped[datetime | None] = mapped_column()

    __table_args__ = (
        UniqueConstraint("user_id", "provider", "item_key", name="uq_discovery_items_user_provider_item"),
        Index("idx_discovery_items_user_status", "user_id", "status"),
        Index("idx_discovery_items_provider", "provider"),
        Index("idx_discovery_items_score", "score"),
    )
