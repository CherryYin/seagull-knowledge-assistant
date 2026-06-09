from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.config import settings
from pkg.db import Base


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    is_shared: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("categories.id"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    source_type: Mapped[str] = mapped_column(String(50), nullable=False)
    url: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    raw_content: Mapped[str | None] = mapped_column(Text)
    file_path: Mapped[str | None] = mapped_column(Text)
    ingested_at: Mapped[datetime] = mapped_column(server_default=func.now())
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)

    __table_args__ = (
        Index("idx_sources_type", "source_type"),
        Index("idx_sources_hash", "content_hash"),
        Index("idx_sources_category", "category_id"),
        Index("idx_sources_user_id", "user_id"),
    )


class SourceEmbedding(Base):
    __tablename__ = "source_embeddings"

    source_id: Mapped[str] = mapped_column(
        String, primary_key=True
    )
    title_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
    summary_vec = mapped_column(Vector(settings.EMBEDDING_DIM))


class SourceChunk(Base):
    """A chunk of a source document, with its own embedding for fine-grained retrieval."""
    __tablename__ = "source_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(settings.EMBEDDING_DIM))

    __table_args__ = (
        Index("idx_source_chunks_source", "source_id"),
    )
