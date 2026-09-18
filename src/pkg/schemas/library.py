from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


LibraryEntityType = Literal["source", "note", "wiki"]
LibraryMediaType = Literal["text", "image", "video"]


class LibrarySearchRequest(BaseModel):
    query: str = ""
    mode: str = Field(default="auto", pattern=r"^(auto|sql|vector|hybrid)$")
    entity_types: list[LibraryEntityType] | None = None
    media_types: list[LibraryMediaType] | None = None
    lifecycle_statuses: list[str] | None = None
    category_ids: list[int] | None = None
    tags: list[str] | None = None
    date_from: datetime | None = None
    date_to: datetime | None = None
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class LibrarySearchHit(BaseModel):
    field: str
    reason: str
    text: str | None = None


class LibrarySearchResult(BaseModel):
    id: str
    entity_type: LibraryEntityType
    result_type: str
    media_type: LibraryMediaType | None = None
    title: str
    excerpt: str | None = None
    score: float
    href: str
    created_at: datetime | None = None
    updated_at: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    lifecycle_status: str | None = None
    category_id: int | None = None
    category_name: str | None = None
    category_label: str | None = None
    source_type: str | None = None
    thumbnail_url: str | None = None
    playback_url: str | None = None
    segment_id: int | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    hit: LibrarySearchHit


class LibrarySearchResponse(BaseModel):
    items: list[LibrarySearchResult]
    total: int
    limit: int
    offset: int
    facets: dict[str, dict[str, int]] = Field(default_factory=dict)


class LibraryCategoryOption(BaseModel):
    id: int
    name: str
    label: str


class LibraryFilterOptions(BaseModel):
    categories: list[LibraryCategoryOption]
    tags: list[str]
