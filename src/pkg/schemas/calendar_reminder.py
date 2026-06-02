from datetime import datetime

from pydantic import BaseModel, Field


class CalendarReminderCreate(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    text: str = Field(min_length=1, max_length=1000)


class CalendarReminderUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=1000)
    is_done: bool | None = None


class CalendarReminderRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    date: str
    text: str
    is_done: bool
    created_at: datetime
    updated_at: datetime


class CalendarReminderList(BaseModel):
    items: list[CalendarReminderRead]
    total: int
    overdue_count: int = 0
