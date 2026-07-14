from datetime import datetime

from pydantic import BaseModel, Field


CALENDAR_RECURRENCE_PATTERN = r"^(once|daily|weekly|biweekly)$"


class CalendarReminderCreate(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    text: str = Field(min_length=1, max_length=1000)
    note_id: str | None = None
    recurrence: str = Field(default="once", pattern=CALENDAR_RECURRENCE_PATTERN)


class CalendarReminderUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=1000)
    note_id: str | None = None
    recurrence: str | None = Field(default=None, pattern=CALENDAR_RECURRENCE_PATTERN)
    is_done: bool | None = None
    occurrence_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class CalendarReminderRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    date: str
    text: str
    note_id: str | None = None
    recurrence: str
    is_done: bool
    created_at: datetime
    updated_at: datetime


class CalendarReminderList(BaseModel):
    items: list[CalendarReminderRead]
    total: int
    overdue_count: int = 0
