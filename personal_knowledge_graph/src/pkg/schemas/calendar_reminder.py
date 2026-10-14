from datetime import date as Date, datetime

from pydantic import BaseModel, Field, field_validator, model_validator


CALENDAR_RECURRENCE_PATTERN = r"^(once|daily|weekly|biweekly)$"


class CalendarReminderLinkedNote(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    status: str


class ReminderFields(BaseModel):
    @field_validator("date", "occurrence_date", check_fields=False)
    @classmethod
    def valid_date(cls, value):
        if value is not None:
            if Date.fromisoformat(value).isoformat() != value:
                raise ValueError("Use a real calendar date in YYYY-MM-DD format")
        return value

    @field_validator("text", check_fields=False)
    @classmethod
    def nonblank_text(cls, value):
        if value is None or not value.strip():
            raise ValueError("Task text must not be blank")
        return value.strip()


class CalendarReminderCreate(ReminderFields):
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    project_id: str | None = Field(default=None, min_length=1, max_length=200)
    base_revision: int | None = Field(default=None, ge=1)
    text: str = Field(min_length=1, max_length=1000)
    note_id: str | None = None
    note_ids: list[str] | None = Field(default=None, max_length=20)
    recurrence: str = Field(default="once", pattern=CALENDAR_RECURRENCE_PATTERN)

    @model_validator(mode="after")
    def recurring_date(self):
        if self.recurrence != "once" and self.date is None:
            raise ValueError("Recurring reminders require a start date")
        return self


class CalendarReminderUpdate(ReminderFields):
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    project_id: str | None = Field(default=None, min_length=1, max_length=200)
    base_revision: int | None = Field(default=None, ge=1)
    target_revision: int | None = Field(default=None, ge=1)
    text: str | None = Field(default=None, min_length=1, max_length=1000)
    note_id: str | None = None
    note_ids: list[str] | None = Field(default=None, max_length=20)
    recurrence: str | None = Field(default=None, pattern=CALENDAR_RECURRENCE_PATTERN)
    is_done: bool | None = None
    occurrence_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("recurrence", "is_done")
    @classmethod
    def reject_null(cls, value):
        if value is None:
            raise ValueError("must not be null")
        return value


class CalendarReminderRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    date: str | None
    project_id: str | None = None
    project_revision: int | None = None
    completed_at: datetime | None = None
    text: str
    note_id: str | None = None
    linked_note: CalendarReminderLinkedNote | None = None
    note_ids: list[str] = Field(default_factory=list)
    linked_notes: list[CalendarReminderLinkedNote] = Field(default_factory=list)
    recurrence: str
    is_done: bool
    created_at: datetime
    updated_at: datetime


class CalendarReminderList(BaseModel):
    items: list[CalendarReminderRead]
    total: int
    overdue_count: int = 0


class ProjectTaskList(CalendarReminderList):
    pending_count: int = 0
    completed_count: int = 0
    next_task: CalendarReminderRead | None = None
