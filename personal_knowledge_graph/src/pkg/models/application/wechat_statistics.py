from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class WechatStatisticsSnapshot(Base):
    __tablename__ = "wechat_statistics_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    credential_id: Mapped[int] = mapped_column(Integer, ForeignKey("user_api_credentials.id", ondelete="CASCADE"), nullable=False)
    account_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    publication_date: Mapped[date] = mapped_column(Date, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)

    __table_args__ = (
        Index("ix_wechat_stats_scope", "user_id", "credential_id", "account_hash", "publication_date", "fetched_at"),
    )
