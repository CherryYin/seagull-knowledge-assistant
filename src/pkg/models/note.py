from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from pkg.config import settings
from pkg.db import Base


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("categories.id"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    note_type: Mapped[str] = mapped_column(String(50), nullable=False)
    domains: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    abstract: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str | None] = mapped_column(Text)
    project: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), server_default="seed")
    confidence: Mapped[str] = mapped_column(String(20), server_default="medium")
    source_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    file_path: Mapped[str | None] = mapped_column(Text)
    word_count: Mapped[int | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_notes_domains", "domains", postgresql_using="gin"),
        Index("idx_notes_tags", "tags", postgresql_using="gin"),
        Index("idx_notes_sources", "source_ids", postgresql_using="gin"),
        Index("idx_notes_category", "category_id"),
        Index("idx_notes_user_id", "user_id"),
    )


class NoteEmbedding(Base):
    __tablename__ = "note_embeddings"

    note_id: Mapped[str] = mapped_column(
        String, primary_key=True
    )
    abstract_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
    title_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
