from datetime import datetime

from pydantic import BaseModel, Field

from pkg.schemas.source import SourceRead


class ArxivSearchRequest(BaseModel):
    query: str | None = None
    author: str | None = None
    category: str | None = None
    paper_id: str | None = None
    date_from: str | None = None
    date_to: str | None = None
    max_results: int = Field(default=10, ge=1, le=50)


class ArxivPaper(BaseModel):
    cache_id: int | None = None
    cache_status: str | None = None
    cache_expires_at: datetime | None = None
    source_id: str | None = None
    arxiv_id: str
    title: str
    authors: list[str]
    abstract: str
    categories: list[str]
    published: datetime | None = None
    updated: datetime | None = None
    pdf_url: str | None = None
    entry_url: str | None = None
    doi: str | None = None


class ArxivSearchResponse(BaseModel):
    items: list[ArxivPaper]
    total: int


class ArxivImportRequest(BaseModel):
    paper: ArxivPaper | None = None
    paper_id: str | None = None
    category_id: int = 1
    fetch_pdf_text: bool = False


class GitHubRepoSearchRequest(BaseModel):
    query: str
    language: str | None = None
    topic: str | None = None
    min_stars: int | None = Field(default=None, ge=0)
    pushed_after: str | None = None
    max_results: int = Field(default=10, ge=1, le=50)


class GitHubRepo(BaseModel):
    cache_id: int | None = None
    cache_status: str | None = None
    cache_expires_at: datetime | None = None
    source_id: str | None = None
    full_name: str
    owner: str
    name: str
    description: str | None = None
    topics: list[str] = []
    language: str | None = None
    stars: int = 0
    forks: int = 0
    default_branch: str | None = None
    pushed_at: datetime | None = None
    clone_url: str | None = None
    html_url: str
    license: str | None = None
    readme: str | None = None


class GitHubRepoSearchResponse(BaseModel):
    items: list[GitHubRepo]
    total: int


class GitHubImportRequest(BaseModel):
    repo: GitHubRepo | None = None
    full_name: str | None = None
    category_id: int = 1
    fetch_readme: bool = True


class ConnectorImportResponse(BaseModel):
    source: SourceRead
    created: bool
    dedupe_key: str


class ExternalPaper(BaseModel):
    provider: str
    provider_id: str
    title: str
    abstract: str | None = None
    authors: list[str] = []
    published_at: datetime | None = None
    updated_at: datetime | None = None
    url: str | None = None
    pdf_url: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    fields_of_study: list[str] = []
    citation_count: int | None = None
    reference_count: int | None = None
    venue: str | None = None
    year: int | None = None
    keywords: list[str] = []
    metadata: dict | None = None
