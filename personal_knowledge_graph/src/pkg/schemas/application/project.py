from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


ProjectStatus = Literal["active", "completed"]
ProjectResourceType = Literal["source", "note", "wiki", "asset", "chat_session"]


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=4000)
    completion_criteria: str = Field(default="", max_length=4000)

    @field_validator("title", "goal", "completion_criteria")
    @classmethod
    def normalize_text(cls, value: str, info):
        value = value.strip()
        if info.field_name != "completion_criteria" and not value:
            raise ValueError("must not be blank")
        return value


class ProjectRevisionRequest(BaseModel):
    base_revision: int = Field(ge=1)


class ProjectUpdate(ProjectRevisionRequest):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    goal: str | None = Field(default=None, min_length=1, max_length=4000)
    completion_criteria: str | None = Field(default=None, max_length=4000)
    status: ProjectStatus | None = None

    @field_validator("title", "goal", "completion_criteria", "status")
    @classmethod
    def reject_null_and_blank(cls, value, info):
        if value is None:
            raise ValueError("must not be null")
        value = value.strip()
        if info.field_name != "completion_criteria" and not value:
            raise ValueError("must not be blank")
        return value


class ProjectRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    goal: str
    completion_criteria: str
    status: ProjectStatus
    revision: int
    next_reminder_id: str | None = None
    archived_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    resource_counts: dict[str, int] = Field(default_factory=dict)


class ProjectList(BaseModel):
    items: list[ProjectRead]
    total: int


class ProjectResourceInput(BaseModel):
    resource_type: ProjectResourceType
    resource_id: str = Field(min_length=1, max_length=200)
    reason: str = Field(default="", max_length=1000)

    @field_validator("resource_id", "reason")
    @classmethod
    def normalize_text(cls, value: str, info):
        value = value.strip()
        if info.field_name == "resource_id" and not value:
            raise ValueError("must not be blank")
        return value


class ProjectResourcesAdd(ProjectRevisionRequest):
    resources: list[ProjectResourceInput] = Field(min_length=1, max_length=50)


class ProjectResourceOption(BaseModel):
    resource_type: ProjectResourceType
    resource_id: str
    title: str
    status: str | None = None
    href: str
    updated_at: datetime | None = None


class ProjectResourceRead(ProjectResourceOption):
    id: str
    reason: str
    created_at: datetime


class ProjectResourceList(BaseModel):
    items: list[ProjectResourceRead]
    total: int
    revision: int


class ProjectResourceOptions(BaseModel):
    items: list[ProjectResourceOption]
    total: int


class ProjectResourcesResult(BaseModel):
    project: ProjectRead
    added: int


class ProjectNextTask(ProjectRevisionRequest):
    reminder_id: str | None = Field(default=None, min_length=1, max_length=200)


class TodoResourceInput(ProjectResourceInput):
    resource_type: Literal["source", "note", "asset"]


class TodoResourcesAdd(ProjectRevisionRequest):
    role: Literal["context", "result"]
    resources: list[TodoResourceInput] = Field(min_length=1, max_length=50)

    @field_validator("resources")
    @classmethod
    def validate_result(cls, value, info):
        if info.data.get("role") == "result" and any(item.resource_type == "source" for item in value):
            raise ValueError("Results must be Notes or Assets")
        return value


class TodoResourceRead(ProjectResourceRead):
    role: Literal["context", "result"]
    reminder_id: str
    task_text: str
    task_done: bool


class TodoResourceList(BaseModel):
    items: list[TodoResourceRead]
    total: int
    revision: int | None


class ProjectSavedResultLink(ProjectRevisionRequest):
    resource_type: Literal["note", "asset", "wiki"]
    resource_id: str = Field(min_length=1, max_length=200)
    reminder_id: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_task_result(self):
        if self.reminder_id and self.resource_type == "wiki":
            raise ValueError("Task results must be Notes or Assets; Wiki drafts can link to the Project only")
        return self


class ProjectSavedResultRead(BaseModel):
    project: ProjectRead
    resource_type: Literal["note", "asset", "wiki"]
    resource_id: str
    reminder_id: str | None


class ProjectContextRef(BaseModel):
    resource_type: Literal["source", "note", "wiki", "asset"]
    resource_id: str = Field(min_length=1, max_length=200)


class ProjectContextRequest(ProjectRevisionRequest):
    reminder_id: str | None = Field(default=None, min_length=1, max_length=200)
    resources: list[ProjectContextRef] = Field(default_factory=list, max_length=20)
    expected_fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ProjectContextResource(ProjectResourceOption):
    summary: str
    truncated: bool


class ProjectContextTask(BaseModel):
    id: str
    text: str
    is_done: bool
    date: str | None
    recurrence: str
    updated_at: datetime | None


class ProjectContextSnapshot(BaseModel):
    version: Literal[1] = 1
    project_id: str
    project_revision: int
    title: str
    goal: str
    completion_criteria: str
    status: ProjectStatus
    generated_at: datetime
    task: ProjectContextTask | None
    resources: list[ProjectContextResource]
    context_text: str = Field(max_length=20000)
    truncated: bool
    fingerprint: str
    launch_fingerprint: str | None = None


class ProjectContextSessionCreate(ProjectContextRequest):
    expected_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    session_id: str = Field(min_length=1, max_length=200)
