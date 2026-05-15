import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


def _generate_run_id() -> str:
    return f"run-{uuid.uuid4()}"


def _generate_event_id() -> str:
    return f"run-event-{uuid.uuid4()}"


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_generate_run_id)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    profile_id: Mapped[str | None] = mapped_column(String, ForeignKey("agent_profiles.id"), nullable=True)
    agent_type: Mapped[str] = mapped_column(String(50), nullable=False, server_default="action")
    status: Mapped[str] = mapped_column(String(30), nullable=False, server_default="queued")
    task: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_agent_runs_user_id", "user_id"),
        Index("idx_agent_runs_profile_id", "profile_id"),
        Index("idx_agent_runs_status", "status"),
        Index("idx_agent_runs_updated_at", "updated_at"),
    )


class AgentRunEvent(Base):
    __tablename__ = "agent_run_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_generate_event_id)
    run_id: Mapped[str] = mapped_column(String, ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        Index("idx_agent_run_events_run_id", "run_id"),
        Index("idx_agent_run_events_user_id", "user_id"),
        Index("idx_agent_run_events_created_at", "created_at"),
    )
