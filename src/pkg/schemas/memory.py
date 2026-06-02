from datetime import datetime

from pydantic import BaseModel, Field


class MemoryNodeRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    node_type: str
    scope_id: str
    level: str
    title: str
    summary: str | None = None
    content: str
    child_node_ids: list[str]
    derived_from_notes: list[str]
    derived_from_sources: list[str]
    derived_from_chunks: list[int]
    metadata_: dict | None = Field(None, alias="metadata_")
    confidence_score: float | None = None
    created_at: datetime
    updated_at: datetime


class MemoryNodeList(BaseModel):
    items: list[MemoryNodeRead]
    total: int


class MemoryNodeUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    summary: str | None = None
    content: str | None = None
    status: str | None = Field(default=None, pattern=r"^(active|archived|rejected|merged)$")


class TopicMemoryCompileRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    level: str = Field(default="topic", pattern=r"^(topic|subtopic)$")
    source_node_ids: list[str] | None = None
    limit: int = Field(default=20, ge=1, le=100)


class TopicMemoryCandidate(BaseModel):
    node: MemoryNodeRead
    reason: str


class TopicMemoryCandidateList(BaseModel):
    items: list[TopicMemoryCandidate]
    total: int


class MemoryEdgeRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    from_node_id: str
    to_kind: str
    to_id: str
    edge_type: str
    weight: float | None = None
    description: str | None = None
    metadata_: dict | None = Field(None, alias="metadata_")
    created_at: datetime
    updated_at: datetime


class MemoryEdgeList(BaseModel):
    items: list[MemoryEdgeRead]
    total: int


class MemoryGraphRead(BaseModel):
    nodes: list[MemoryNodeRead]
    edges: list[MemoryEdgeRead]


class MemoryNodeMergeRequest(BaseModel):
    target_node_id: str = Field(min_length=1, max_length=300)
    archive_source: bool = True
