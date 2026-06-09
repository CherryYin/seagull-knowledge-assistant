from datetime import datetime

from pydantic import BaseModel, Field


class PaperDiscoveryProfileBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    goal_prompt: str | None = None
    mode: str = Field(default="query", pattern=r"^(query|trend|hybrid)$")
    provider: str = Field(default="openalex", min_length=1, max_length=50)
    schedule: str = Field(default="manual", pattern=r"^(manual|daily|weekly)$")
    is_enabled: bool = True
    max_results: int = Field(default=20, ge=1, le=200)
    discovery_window_days: int = Field(default=365, ge=1, le=3650)
    time_window_days: int | None = Field(default=None, ge=1, le=3650)
    include_terms: list[str] = Field(default_factory=list)
    exclude_terms: list[str] = Field(default_factory=list)
    preferred_authors: list[str] = Field(default_factory=list)
    preferred_venues: list[str] = Field(default_factory=list)
    preferred_fields: list[str] = Field(default_factory=list)
    preferred_arxiv_categories: list[str] = Field(default_factory=list)
    seed_paper_ids: list[str] = Field(default_factory=list)


class PaperDiscoveryProfileCreate(PaperDiscoveryProfileBase):
    pass


class PaperDiscoveryProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    goal_prompt: str | None = None
    mode: str | None = Field(default=None, pattern=r"^(query|trend|hybrid)$")
    provider: str | None = Field(default=None, min_length=1, max_length=50)
    schedule: str | None = Field(default=None, pattern=r"^(manual|daily|weekly)$")
    is_enabled: bool | None = None
    max_results: int | None = Field(default=None, ge=1, le=200)
    discovery_window_days: int | None = Field(default=None, ge=1, le=3650)
    time_window_days: int | None = Field(default=None, ge=1, le=3650)
    include_terms: list[str] | None = None
    exclude_terms: list[str] | None = None
    preferred_authors: list[str] | None = None
    preferred_venues: list[str] | None = None
    preferred_fields: list[str] | None = None
    preferred_arxiv_categories: list[str] | None = None
    seed_paper_ids: list[str] | None = None


class PaperDiscoveryProfileRead(PaperDiscoveryProfileBase):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    last_run_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class PaperDiscoveryProfileList(BaseModel):
    items: list[PaperDiscoveryProfileRead]
    total: int


class PaperDiscoveryRunRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    profile_id: int
    user_id: str
    mode: str
    status: str
    query_bundle: dict | None = None
    stats: dict | None = None
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None


class PaperDiscoveryRunList(BaseModel):
    items: list[PaperDiscoveryRunRead]
    total: int


class PaperTrendSnapshotRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    profile_id: int | None = None
    provider: str
    scope_key: str
    window_start: datetime
    window_end: datetime
    topic: str | None = None
    term: str
    count: int
    baseline_count: int | None = None
    growth_rate: float | None = None
    score: float | None = None
    metadata_: dict | None = None
    created_at: datetime


class PaperTrendSnapshotList(BaseModel):
    items: list[PaperTrendSnapshotRead]
    total: int


class PaperDiscoveryPreviewRequest(BaseModel):
    mode: str | None = Field(default=None, pattern=r"^(query|trend|hybrid)$")


class PaperDiscoveryExecuteRequest(BaseModel):
    mode: str | None = Field(default=None, pattern=r"^(query|trend|hybrid)$")
    limit: int | None = Field(default=None, ge=1, le=500)


class PaperQuerySpec(BaseModel):
    label: str
    query: str
    provider: str = "semantic_scholar"
    rationale: str | None = None
    filters: dict = Field(default_factory=dict)


class PaperQueryBundle(BaseModel):
    profile_name: str
    mode: str
    provider: str
    primary_queries: list[PaperQuerySpec] = Field(default_factory=list)
    expanded_queries: list[PaperQuerySpec] = Field(default_factory=list)
    trend_queries: list[PaperQuerySpec] = Field(default_factory=list)
    negative_terms: list[str] = Field(default_factory=list)
    author_filters: list[str] = Field(default_factory=list)
    field_filters: list[str] = Field(default_factory=list)
    venue_filters: list[str] = Field(default_factory=list)
    date_filters: dict = Field(default_factory=dict)
