from datetime import datetime

from pydantic import BaseModel


class SaveDocumentRequest(BaseModel):
    message_content: str
    title: str | None = None
    storage_uri: str | None = None
    document_format: str | None = None
    document_filename: str | None = None
    session_id: str | None = None
    category_id: int | None = None


class SaveDocumentResponse(BaseModel):
    source_id: str
    note_id: str


class RememberRequest(BaseModel):
    content: str
    session_id: str | None = None
    title: str | None = None
    category_id: int | None = None


class KnowledgeStatsRead(BaseModel):
    item_id: str
    item_type: str
    title: str
    category_name: str | None = None
    search_count: int
    retrieval_count: int
    reference_count: int
    total_count: int
    last_accessed_at: datetime | None = None


class KnowledgeStatsList(BaseModel):
    items: list[KnowledgeStatsRead]
    total: int


class DashboardCounts(BaseModel):
    notes: int
    sources: int
    chats: int
    digest_pending: int


class DashboardTrendDay(BaseModel):
    date: str
    notes: int = 0
    sources: int = 0
    chats: int = 0


class CategoryDistribution(BaseModel):
    name: str
    display_name: str
    notes: int = 0
    sources: int = 0


class NoteTypeDistribution(BaseModel):
    type: str
    count: int


class DashboardResponse(BaseModel):
    counts: DashboardCounts
    trends: list[DashboardTrendDay]
    category_distribution: list[CategoryDistribution]
    note_type_distribution: list[NoteTypeDistribution]
