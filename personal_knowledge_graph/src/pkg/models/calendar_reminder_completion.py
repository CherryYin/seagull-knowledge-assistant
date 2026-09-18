import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


def _generate_completion_id() -> str:
    return f"reminder-completion-{uuid.uuid4()}"


class CalendarReminderCompletion(Base):
    __tablename__ = "calendar_reminder_completions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_generate_completion_id)
    reminder_id: Mapped[str] = mapped_column(String, ForeignKey("calendar_reminders.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    occurrence_date: Mapped[str] = mapped_column(String(10), nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("reminder_id", "occurrence_date", name="uq_calendar_reminder_completion_occurrence"),
        Index("idx_calendar_reminder_completions_user_date", "user_id", "occurrence_date"),
    )
