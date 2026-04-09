from datetime import datetime

from pydantic import BaseModel


class ChatMessageSchema(BaseModel):
    id: str
    role: str
    content: str
    created_at: str


class ChatSessionCreate(BaseModel):
    id: str | None = None
    title: str = "New Session"
    messages: list[ChatMessageSchema] = []


class ChatSessionRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    messages: list[ChatMessageSchema]
    created_at: datetime
    updated_at: datetime


class ChatSessionList(BaseModel):
    items: list[ChatSessionRead]
    total: int


class ChatSessionUpdate(BaseModel):
    title: str | None = None
    messages: list[ChatMessageSchema] | None = None
