import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSON, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default="New Session")
    messages: Mapped[list] = mapped_column(JSONB, server_default="[]")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    profile_id: Mapped[str | None] = mapped_column(String, nullable=True)
    harness_format_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    harness_created_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cwd: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_session_id: Mapped[str | None] = mapped_column(String, nullable=True)
    seed_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    origin: Mapped[str | None] = mapped_column(String(30), nullable=True)
    delegation_depth: Mapped[int | None] = mapped_column(Integer, nullable=True)
    agent_preset: Mapped[str | None] = mapped_column(Text, nullable=True)
    persistence_incarnation: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    persistence_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    next_event_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    projection_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="-1")
    materialized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint("harness_created_at_ms IS NULL OR harness_created_at_ms >= 0", name="ck_chat_sessions_harness_created_at_ms"),
        CheckConstraint("seed_length IS NULL OR seed_length >= 0", name="ck_chat_sessions_seed_length"),
        CheckConstraint("origin IS NULL OR origin = 'subagent'", name="ck_chat_sessions_origin"),
        CheckConstraint("delegation_depth IS NULL OR delegation_depth >= 0", name="ck_chat_sessions_delegation_depth"),
        CheckConstraint("persistence_revision >= 0", name="ck_chat_sessions_persistence_revision"),
        CheckConstraint("next_event_seq >= 0", name="ck_chat_sessions_next_event_seq"),
        CheckConstraint("projection_seq >= -1", name="ck_chat_sessions_projection_seq"),
        Index("ix_chat_sessions_parent_session_id", "parent_session_id"),
        Index("ix_chat_sessions_materialized_at", "materialized_at"),
    )


class ChatSessionEvent(Base):
    __tablename__ = "chat_session_events"

    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), primary_key=True
    )
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    time_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    source_event_seqs: Mapped[list[int] | None] = mapped_column(JSON, nullable=True)
    surface_op: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ignorable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    __table_args__ = (
        CheckConstraint("seq >= 0", name="ck_chat_session_events_seq"),
        CheckConstraint("time_ms >= 0", name="ck_chat_session_events_time_ms"),
        Index("ix_chat_session_events_type", "session_id", "type", "seq"),
    )
