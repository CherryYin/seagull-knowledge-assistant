from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.config import settings
from pkg.db import Base
from pkg.models import user as _user_models  # noqa: F401 - register users table for FK resolution


class MemoryNode(Base):
    __tablename__ = "memory_nodes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    node_type: Mapped[str] = mapped_column(String(50), nullable=False)
    scope_id: Mapped[str] = mapped_column(String(200), nullable=False)
    level: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    child_node_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    derived_from_notes: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    derived_from_sources: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    derived_from_chunks: Mapped[list[int]] = mapped_column(ARRAY(Integer), server_default="{}")
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    confidence_score: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "node_type", "scope_id", "level", name="uq_memory_nodes_scope"),
        Index("idx_memory_nodes_user_id", "user_id"),
        Index("idx_memory_nodes_type_level", "node_type", "level"),
        Index("idx_memory_nodes_scope", "scope_id"),
        Index("idx_memory_nodes_notes", "derived_from_notes", postgresql_using="gin"),
        Index("idx_memory_nodes_sources", "derived_from_sources", postgresql_using="gin"),
    )


class MemoryEmbedding(Base):
    __tablename__ = "memory_embeddings"

    memory_node_id: Mapped[str] = mapped_column(
        String, ForeignKey("memory_nodes.id", ondelete="CASCADE"), primary_key=True
    )
    title_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
    summary_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
    content_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
