from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base
from pkg.models import user as _user_models  # noqa: F401 - register users table for FK resolution
from pkg.models import memory as _memory_models  # noqa: F401 - register memory_nodes table for FK resolution


class MemoryEdge(Base):
    __tablename__ = "memory_edges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    from_node_id: Mapped[str] = mapped_column(String, ForeignKey("memory_nodes.id", ondelete="CASCADE"), nullable=False)
    to_kind: Mapped[str] = mapped_column(String(50), nullable=False)
    to_id: Mapped[str] = mapped_column(String, nullable=False)
    edge_type: Mapped[str] = mapped_column(String(50), nullable=False)
    weight: Mapped[float | None] = mapped_column(Float)
    description: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("from_node_id", "to_kind", "to_id", "edge_type", name="uq_memory_edges_relation"),
        Index("idx_memory_edges_user", "user_id"),
        Index("idx_memory_edges_from", "from_node_id"),
        Index("idx_memory_edges_to", "to_kind", "to_id"),
        Index("idx_memory_edges_type", "edge_type"),
    )
