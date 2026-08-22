from datetime import datetime

from pydantic import BaseModel


class ChatMessageSchema(BaseModel):
    id: str
    role: str
    content: str
    created_at: str
    metadata: dict | None = None


class ChatSessionCreate(BaseModel):
    id: str | None = None
    title: str = "New Session"
    messages: list[ChatMessageSchema] = []
    profile_id: str | None = None


class ChatSessionRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    messages: list[ChatMessageSchema]
    profile_id: str | None = None
    created_at: datetime
    updated_at: datetime


class ChatSessionList(BaseModel):
    items: list[ChatSessionRead]
    total: int


class ChatSessionUpdate(BaseModel):
    title: str | None = None
    messages: list[ChatMessageSchema] | None = None


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
