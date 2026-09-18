import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


def _generate_reminder_id() -> str:
    return f"reminder-{uuid.uuid4()}"


class CalendarReminder(Base):
    __tablename__ = "calendar_reminders"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_generate_reminder_id)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    date: Mapped[str] = mapped_column(String(10), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    note_id: Mapped[str | None] = mapped_column(String, ForeignKey("notes.id", ondelete="SET NULL"), nullable=True)
    recurrence: Mapped[str] = mapped_column(String(20), nullable=False, server_default="once")
    is_done: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_calendar_reminders_user_date", "user_id", "date"),
        Index("idx_calendar_reminders_user_done", "user_id", "is_done"),
    )


class CalendarReminderNote(Base):
    __tablename__ = "calendar_reminder_notes"

    reminder_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("calendar_reminders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    note_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("notes.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    __table_args__ = (Index("idx_calendar_reminder_notes_note_id", "note_id"),)
