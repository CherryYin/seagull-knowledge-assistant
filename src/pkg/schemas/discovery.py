from datetime import datetime

from pydantic import BaseModel, Field

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
    providers: list[str] = Field(default_factory=lambda: ["github", "rss", "web"])
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


class DiscoveryFeedbackRequest(BaseModel):
    action: str = Field(pattern=r"^(keep|save|dismiss)$")
    note: str | None = None


class DiscoveryFeedbackResult(BaseModel):
    item: DiscoveryItemRead
    source: SourceRead | None = None
    created: bool | None = None
