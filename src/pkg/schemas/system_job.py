from datetime import datetime

from pydantic import BaseModel, Field


class SystemJobRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str | None = None
    job_type: str
    status: str
    title: str
    detail: str | None = None
    metadata_: dict | None = Field(default=None, serialization_alias="metadata")
    error_message: str | None = None
    duration_ms: float | None = None
    started_at: datetime
    ended_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class SystemJobList(BaseModel):
    items: list[SystemJobRead]
    total: int


class SchedulerTaskStatus(BaseModel):
    name: str
    job_type: str
    title: str
    enabled: bool
    schedule_type: str
    last_run_at: datetime | None = None
    next_run_at: datetime | None = None
    due_now: bool


class SchedulerStatusList(BaseModel):
    items: list[SchedulerTaskStatus]
