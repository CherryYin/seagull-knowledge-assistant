from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator
from pkg.schemas.application.project import ProjectContextSnapshot


class ChatMessageSchema(BaseModel):
    id: str
    role: str
    content: str
    created_at: str
    metadata: dict | None = None


class ResearchWebPreview(BaseModel):
    title: str = Field(max_length=300)
    url: HttpUrl
    summary: str | None = Field(default=None, max_length=1200)
    source_name: str | None = None
    published_at: str | None = None
    retrieved_at: datetime


class ResearchPlan(BaseModel):
    mode: Literal["quick_overview", "support_decision"] = "quick_overview"
    comparison_dimensions: list[str] = Field(default_factory=list, max_length=6)
    approved_web_query: str | None = Field(default=None, max_length=300)
    web_results: list[ResearchWebPreview] = Field(default_factory=list, max_length=8)

    @field_validator("comparison_dimensions")
    @classmethod
    def nonempty_dimensions(cls, dimensions: list[str]) -> list[str]:
        if any(not isinstance(value, str) or not value.strip() or len(value) > 100 for value in dimensions):
            raise ValueError("comparison dimensions must be nonempty and at most 100 characters")
        return [value.strip() for value in dimensions]


class ResearchState(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    status: Literal["prepared", "running", "awaiting_input", "awaiting_review", "failed", "stopped"]
    asset_id: str | None = None
    plan: ResearchPlan | None = None

    @field_validator("question")
    @classmethod
    def nonempty_question(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("question must not be blank")
        return value.strip()


class ChatSessionCreate(BaseModel):
    id: str | None = None
    title: str = "New Session"
    messages: list[ChatMessageSchema] = []
    research_state: ResearchState | None = None
    profile_id: str | None = None
    is_ephemeral: bool = False


class ChatSessionRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    messages: list[ChatMessageSchema]
    research_state: ResearchState | None = None
    project_context: ProjectContextSnapshot | None = None
    profile_id: str | None = None
    is_ephemeral: bool = False
    created_at: datetime
    updated_at: datetime


class ChatSessionList(BaseModel):
    items: list[ChatSessionRead]
    total: int


class ChatSessionUpdate(BaseModel):
    title: str | None = None
    messages: list[ChatMessageSchema] | None = None
    research_state: ResearchState | None = None


class HarnessSessionHeaderSchema(BaseModel):
    version: int
    id: str
    created_at_ms: int
    cwd: str | None = None
    parent_session_id: str | None = None
    seed_length: int | None = None
    origin: str | None = None
    delegation_depth: int | None = None
    agent_preset: str | None = None


class HarnessSessionEventSchema(BaseModel):
    seq: int
    type: str
    time_ms: int
    data: dict
    source_event_seqs: list[int] | None = None
    surface_op: dict | None = None
    ignorable: bool | None = None
