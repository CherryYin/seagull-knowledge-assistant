from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class ConnectorTrendItem(Base):
    __tablename__ = "connector_trend_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    trend_date: Mapped[str] = mapped_column(String(10), nullable=False)
    item_key: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    rank: Mapped[int | None] = mapped_column(Integer)
    score: Mapped[float | None] = mapped_column(Float)
    source_id: Mapped[str | None] = mapped_column(String)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "provider", "trend_date", "item_key", name="uq_connector_trend_day_item"),
        Index("idx_connector_trends_user_provider_date", "user_id", "provider", "trend_date"),
        Index("idx_connector_trends_item", "provider", "item_key"),
    )
