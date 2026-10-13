from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


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
