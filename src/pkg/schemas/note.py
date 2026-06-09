from datetime import datetime

from pydantic import BaseModel, Field


class NoteCreate(BaseModel):
    """Create a user-authored note.

    Notes represent the user's own writing, synthesis, drafts, or confirmed
    takeaways. They may reference sources, but they are not the external
    evidence objects themselves.
    """

    id: str | None = None
    title: str
    category_id: int = 1
    note_type: str = Field(
        default="inbox",
        pattern=r"^(architecture|case-study|concept|digest|how-to|inbox|remember)$",
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
    """User-authored note returned to clients."""

    model_config = {"from_attributes": True}

    id: str
    title: str
    category_id: int
    category_name: str | None = None
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
    expires_at: datetime | None = None
    kept_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class NoteList(BaseModel):
    items: list[NoteRead]
    total: int


class NoteUpdate(BaseModel):
    """Partial update for a user-authored note."""

    title: str | None = None
    category_id: int | None = None
    note_type: str | None = Field(
        default=None,
        pattern=r"^(architecture|case-study|concept|digest|how-to|inbox|remember)$",
    )
    domains: list[str] | None = None
    tags: list[str] | None = None
    abstract: str | None = None
    content: str | None = None
    project: str | None = None
    status: str | None = None
    confidence: str | None = None
    source_ids: list[str] | None = None


class DigestMergeRequest(BaseModel):
    source_ids: list[str] = Field(min_length=1)


class SearchRequest(BaseModel):
    query: str
    mode: str = Field(default="auto", pattern=r"^(auto|sql|vector|hybrid)$")
    top_k: int = Field(default=5, ge=1, le=50)
    filters: dict | None = None


class SearchResult(BaseModel):
    id: str
    title: str
    type: str  # "source", "source_chunk", "note", "wiki", or "memory"
    layer: str | None = None
    score: float
    abstract: str | None = None
    content_preview: str | None = None
