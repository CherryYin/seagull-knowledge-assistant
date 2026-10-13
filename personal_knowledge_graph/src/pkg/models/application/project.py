import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


RESOURCE_COLUMNS = {
    "source": "source_id", "note": "note_id", "wiki": "wiki_id",
    "asset": "asset_id", "chat_session": "chat_session_id",
}
RESOURCE_CHECK = " OR ".join(
    "(resource_type = '{}' AND {})".format(
        kind, " AND ".join(f"{column} IS {'NOT ' if column == selected else ''}NULL"
                           for column in RESOURCE_COLUMNS.values()),
    )
    for kind, selected in RESOURCE_COLUMNS.items()
)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: f"project-{uuid.uuid4()}")
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    completion_criteria: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", server_default="active")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('active', 'completed')", name="ck_projects_status"),
        CheckConstraint("revision >= 1", name="ck_projects_revision"),
        Index("idx_projects_user_updated", "user_id", "updated_at"),
    )


class ProjectResource(Base):
    __tablename__ = "project_resources"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: f"project-resource-{uuid.uuid4()}")
    project_id: Mapped[str] = mapped_column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(20), nullable=False)
    source_id: Mapped[str | None] = mapped_column(String, ForeignKey("sources.id", ondelete="CASCADE"))
    note_id: Mapped[str | None] = mapped_column(String, ForeignKey("notes.id", ondelete="CASCADE"))
    wiki_id: Mapped[str | None] = mapped_column(String, ForeignKey("wiki_pages.id", ondelete="CASCADE"))
    asset_id: Mapped[str | None] = mapped_column(String, ForeignKey("assets.id", ondelete="CASCADE"))
    chat_session_id: Mapped[str | None] = mapped_column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"))
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(RESOURCE_CHECK, name="ck_project_resources_target"),
        *(UniqueConstraint("project_id", column, name=f"uq_project_resources_{kind}")
          for kind, column in RESOURCE_COLUMNS.items()),
        *(Index(f"idx_project_resources_{kind}", column) for kind, column in RESOURCE_COLUMNS.items()),
        Index("idx_project_resources_project_type", "project_id", "resource_type"),
    )
