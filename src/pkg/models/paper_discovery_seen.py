from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class PaperDiscoverySeenItem(Base):
    __tablename__ = "paper_discovery_seen_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    profile_id: Mapped[int] = mapped_column(Integer, ForeignKey("paper_discovery_profiles.id"), nullable=False)
    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    item_key: Mapped[str] = mapped_column(String, nullable=False)
    paper_provider_id: Mapped[str | None] = mapped_column(String)
    arxiv_id: Mapped[str | None] = mapped_column(String(64))
    doi: Mapped[str | None] = mapped_column(String(255))
    first_seen_run_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("paper_discovery_runs.id"))
    first_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "profile_id", "provider", "item_key", name="uq_paper_discovery_seen_item"),
        Index("idx_paper_discovery_seen_profile", "profile_id", "first_seen_at"),
        Index("idx_paper_discovery_seen_arxiv", "arxiv_id"),
    )
