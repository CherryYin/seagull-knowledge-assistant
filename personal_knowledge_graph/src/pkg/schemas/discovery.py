from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator

from pkg.schemas.source import SourceRead


class DiscoveryItemRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    provider: str
    item_key: str
    title: str
    url: str | None = None
    summary: str | None = None
    payload: dict
    status: str
    score: float | None = None
    why: list | None = None
    source_id: str | None = None
    feedback: dict | None = None
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None = None


class DiscoveryItemList(BaseModel):
    items: list[DiscoveryItemRead]
    total: int


class DiscoveryGenerateRequest(BaseModel):
    providers: list[Literal["arxiv", "github", "news"]] = Field(
        default_factory=lambda: ["arxiv", "github", "news"]
    )
    limit: int = Field(default=50, ge=1, le=200)


class DiscoveryGenerateResult(BaseModel):
    created: int
    updated: int
    skipped: int


class DiscoveryWebResult(BaseModel):
    title: str
    url: str
    summary: str | None = None
    source_name: str | None = None
    published_at: str | None = None


class DiscoveryWebIngestRequest(BaseModel):
    query: str
    items: list[DiscoveryWebResult] = Field(default_factory=list, min_length=1, max_length=50)


class DiscoveryWebSearchRequest(BaseModel):
    query: str
    max_results: int = Field(default=10, ge=1, le=20)


class DiscoveryWebSaveItem(DiscoveryWebResult):
    model_config = {"extra": "forbid"}

    title: str = Field(min_length=1, max_length=500)
    url: str = Field(min_length=1, max_length=2048)
    summary: str | None = Field(default=None, max_length=10000)
    source_name: str | None = Field(default=None, max_length=200)
    published_at: str | None = Field(default=None, max_length=100)

    @field_validator("title", "url", "summary", "source_name", "published_at")
    @classmethod
    def no_null_bytes(cls, value: str | None) -> str | None:
        if value is not None and "\x00" in value:
            raise ValueError("Web result fields cannot contain null bytes")
        return value

    @field_validator("title")
    @classmethod
    def nonblank_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A title is required")
        return value.strip()

    @field_validator("url")
    @classmethod
    def public_link(cls, value: str) -> str:
        parsed = HttpUrl(value.strip())
        if parsed.username or parsed.password:
            raise ValueError("Web result URLs cannot contain credentials")
        normalized = str(parsed).split("#", 1)[0]
        if len(normalized) > 2048:
            raise ValueError("Web result URL is too long")
        return normalized


class DiscoveryWebSaveRequest(BaseModel):
    model_config = {"extra": "forbid"}

    query: str = Field(min_length=1, max_length=500)
    items: list[DiscoveryWebSaveItem] = Field(min_length=1, max_length=20)

    @field_validator("query")
    @classmethod
    def nonblank_query(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("A search query is required")
        return value.strip()


class DiscoveryWebSaveResult(BaseModel):
    items: list[SourceRead]
    created: int
    reused: int


class DiscoveryFeedbackRequest(BaseModel):
    action: str = Field(pattern=r"^(keep|save|dismiss)$")
    note: str | None = None


class DiscoveryFeedbackResult(BaseModel):
    item: DiscoveryItemRead
    source: SourceRead | None = None
    created: bool | None = None
