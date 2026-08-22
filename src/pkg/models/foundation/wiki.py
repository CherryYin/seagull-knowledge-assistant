from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.config import settings
from pkg.db import Base


class WikiPage(Base):
    __tablename__ = "wiki_pages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    page_type: Mapped[str] = mapped_column(String(50), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    domains: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    derived_from_notes: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    derived_from_sources: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    open_questions: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    confidence_score: Mapped[float | None] = mapped_column(Float)
    needs_recompile: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    stale_reason: Mapped[str | None] = mapped_column(Text)
    stale_triggered_at: Mapped[datetime | None] = mapped_column()
    last_compiled_at: Mapped[datetime | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_wiki_pages_user_id", "user_id"),
        Index("idx_wiki_pages_type", "page_type"),
        Index("idx_wiki_pages_tags", "tags", postgresql_using="gin"),
        Index("idx_wiki_pages_domains", "domains", postgresql_using="gin"),
        Index(
            "idx_wiki_pages_needs_recompile",
            "needs_recompile",
            postgresql_where=needs_recompile.is_(True),
        ),
    )


class WikiEmbedding(Base):
    __tablename__ = "wiki_embeddings"

    wiki_id: Mapped[str] = mapped_column(String, ForeignKey("wiki_pages.id", ondelete="CASCADE"), primary_key=True)
    title_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
    summary_vec = mapped_column(Vector(settings.EMBEDDING_DIM))
    content_vec = mapped_column(Vector(settings.EMBEDDING_DIM))


class WikiPageSource(Base):
    __tablename__ = "wiki_page_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    wiki_id: Mapped[str] = mapped_column(String, ForeignKey("wiki_pages.id", ondelete="CASCADE"), nullable=False)
    source_id: Mapped[str] = mapped_column(String, ForeignKey("sources.id", ondelete="CASCADE"), nullable=False)
    relevance_summary: Mapped[str] = mapped_column(Text, nullable=False)
    key_points: Mapped[list | None] = mapped_column(JSONB)
    supporting_claims: Mapped[list | None] = mapped_column(JSONB)
    cited_chunk_ids: Mapped[list[int]] = mapped_column(ARRAY(Integer), server_default="{}")
    confidence_score: Mapped[float | None] = mapped_column(Float)
    last_refreshed_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("wiki_id", "source_id", name="uq_wiki_page_sources_wiki_source"),
        Index("idx_wiki_page_sources_wiki", "wiki_id"),
        Index("idx_wiki_page_sources_source", "source_id"),
    )


class WikiRecompileSuggestion(Base):
    __tablename__ = "wiki_recompile_suggestions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    wiki_id: Mapped[str] = mapped_column(String, ForeignKey("wiki_pages.id", ondelete="CASCADE"), nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(50), nullable=False)
    trigger_id: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_preview: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="pending")
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    reviewed_at: Mapped[datetime | None] = mapped_column()
    applied_at: Mapped[datetime | None] = mapped_column()
    reviewer_note: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint(
            "wiki_id",
            "trigger_type",
            "trigger_id",
            "status",
            name="uq_wiki_recompile_suggestions_open_trigger",
        ),
        Index("idx_wiki_recompile_suggestions_user", "user_id"),
        Index("idx_wiki_recompile_suggestions_wiki", "wiki_id"),
        Index("idx_wiki_recompile_suggestions_status", "status"),
        Index("idx_wiki_recompile_suggestions_trigger", "trigger_type", "trigger_id"),
    )


class WikiMiningRun(Base):
    __tablename__ = "wiki_mining_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="completed")
    window_start: Mapped[datetime | None] = mapped_column()
    window_end: Mapped[datetime | None] = mapped_column()
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_wiki_mining_runs_user_id", "user_id"),
        Index("idx_wiki_mining_runs_status", "status"),
        Index("idx_wiki_mining_runs_created_at", "created_at"),
    )


class WikiInsightCandidate(Base):
    __tablename__ = "wiki_insight_candidates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(Integer, ForeignKey("wiki_mining_runs.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    insight_type: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_refs: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="pending")
    reviewer_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_wiki_insight_candidates_run_id", "run_id"),
        Index("idx_wiki_insight_candidates_user_id", "user_id"),
        Index("idx_wiki_insight_candidates_status", "status"),
    )


class WikiArticleDraft(Base):
    __tablename__ = "wiki_article_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(Integer, ForeignKey("wiki_mining_runs.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    page_type: Mapped[str] = mapped_column(String(50), nullable=False, server_default="topic")
    summary: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_refs: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="candidate")
    reviewer_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_wiki_article_drafts_run_id", "run_id"),
        Index("idx_wiki_article_drafts_user_id", "user_id"),
        Index("idx_wiki_article_drafts_status", "status"),
    )
