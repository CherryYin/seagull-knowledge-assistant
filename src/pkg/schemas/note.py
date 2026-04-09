from datetime import datetime

from pydantic import BaseModel, Field


class NoteCreate(BaseModel):
    id: str | None = None
    title: str
    note_type: str = Field(
        default="inbox",
        pattern=r"^(architecture|case-study|concept|how-to|inbox)$",
    )
    domains: list[str] = []
    tags: list[str] = []
    abstract: str | None = None
    content: str | None = None
    project: str | None = None
    status: str = "seed"
    confidence: str = "medium"
    source_ids: list[str] = []


class NoteRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    note_type: str
    domains: list[str]
    tags: list[str]
    abstract: str | None = None
    content: str | None = None
    project: str | None = None
    status: str
    confidence: str
    source_ids: list[str]
    file_path: str | None = None
    word_count: int | None = None
    created_at: datetime
    updated_at: datetime


class NoteList(BaseModel):
    items: list[NoteRead]
    total: int


class NoteUpdate(BaseModel):
    """Partial update; only set fields are applied."""

    title: str | None = None
    note_type: str | None = Field(
        default=None,
        pattern=r"^(architecture|case-study|concept|how-to|inbox)$",
    )
    domains: list[str] | None = None
    tags: list[str] | None = None
    abstract: str | None = None
    content: str | None = None
    project: str | None = None
    status: str | None = None
    confidence: str | None = None
    source_ids: list[str] | None = None


class SearchRequest(BaseModel):
    query: str
    mode: str = Field(default="auto", pattern=r"^(auto|sql|vector|hybrid)$")
    top_k: int = Field(default=5, ge=1, le=50)
    filters: dict | None = None


class SearchResult(BaseModel):
    id: str
    title: str
    type: str  # "source" or "note"
    score: float
    abstract: str | None = None
    content_preview: str | None = None
