from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AgentRunStatus = Literal[
    "queued",
    "running",
    "thinking",
    "searching",
    "reading",
    "writing",
    "tool_calling",
    "completed",
    "failed",
    "cancelled",
]

AgentRunEventType = Literal[
    "task_received",
    "profile_loaded",
    "state_changed",
    "tool_started",
    "tool_finished",
    "knowledge_searched",
    "note_read",
    "source_read",
    "document_generated",
    "message_delta",
    "error",
    "completed",
]


class AgentRunRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    profile_id: str | None = None
    agent_type: str
    status: str
    task: str
    summary: str | None = None
    result_preview: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class AgentRunEventRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    run_id: str
    user_id: str
    event_type: str
    title: str
    detail: str | None = None
    metadata_: dict | None = Field(default=None, serialization_alias="metadata")
    created_at: datetime


class AgentRunList(BaseModel):
    items: list[AgentRunRead]
    total: int


class AgentRunStatusRead(BaseModel):
    profile_id: str
    profile_name: str
    agent_type: str
    status: str
    current_task: str | None = None
    last_active_at: datetime | None = None
    last_result_preview: str | None = None
    run_id: str | None = None
