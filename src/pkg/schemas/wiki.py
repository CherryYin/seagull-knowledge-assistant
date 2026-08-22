from datetime import datetime

from pydantic import BaseModel, Field


class WikiPageCreate(BaseModel):
    id: str | None = None
    title: str
    page_type: str = Field(default="topic", pattern=r"^(topic|entity|concept|project|comparison)$")
    summary: str | None = None
    content: str = ""
    domains: list[str] = []
    tags: list[str] = []
    derived_from_notes: list[str] = []
    derived_from_sources: list[str] = []
    open_questions: list[str] = []
    confidence_score: float | None = Field(default=None, ge=0, le=1)


class WikiPageUpdate(BaseModel):
    title: str | None = None
    page_type: str | None = Field(
        default=None,
        pattern=r"^(topic|entity|concept|project|comparison)$",
    )
    summary: str | None = None
    content: str | None = None
    domains: list[str] | None = None
    tags: list[str] | None = None
    derived_from_notes: list[str] | None = None
    derived_from_sources: list[str] | None = None
    open_questions: list[str] | None = None
    confidence_score: float | None = Field(default=None, ge=0, le=1)
    needs_recompile: bool | None = None
    stale_reason: str | None = None


class WikiPageRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    page_type: str
    summary: str | None = None
    content: str
    domains: list[str]
    tags: list[str]
    derived_from_notes: list[str]
    derived_from_sources: list[str]
    open_questions: list[str]
    confidence_score: float | None = None
    needs_recompile: bool
    stale_reason: str | None = None
    stale_triggered_at: datetime | None = None
    last_compiled_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class WikiPageList(BaseModel):
    items: list[WikiPageRead]
    total: int


class WikiPageSourceCreate(BaseModel):
    source_id: str
    relevance_summary: str
    key_points: list[dict | str] = []
    supporting_claims: list[dict | str] = []
    cited_chunk_ids: list[int] = []
    confidence_score: float | None = Field(default=None, ge=0, le=1)


class WikiPageSourceRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    wiki_id: str
    source_id: str
    relevance_summary: str
    key_points: list | None = None
    supporting_claims: list | None = None
    cited_chunk_ids: list[int]
    confidence_score: float | None = None
    last_refreshed_at: datetime


class WikiCompileRequest(BaseModel):
    title: str
    page_type: str = Field(default="topic", pattern=r"^(topic|entity|concept|project|comparison)$")
    note_ids: list[str] = []
    source_ids: list[str] = []
    instructions: str | None = None


class WikiUpdateDraftFromSourceRequest(BaseModel):
    wiki_id: str
    source_id: str
    section: str = "Open Questions"
    page_type: str = Field(default="topic", pattern=r"^(topic|entity|concept|project|comparison)$")


class WikiRecompileSuggestionRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    wiki_id: str
    wiki_title: str | None = None
    trigger_type: str
    trigger_id: str
    reason: str
    evidence_preview: str | None = None
    status: str
    metadata_: dict | None = None
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None = None
    applied_at: datetime | None = None
    reviewer_note: str | None = None


class WikiRecompileSuggestionList(BaseModel):
    items: list[WikiRecompileSuggestionRead]
    total: int


class WikiSuggestionStatusUpdate(BaseModel):
    status: str = Field(pattern=r"^(pending|accepted|rejected|dismissed|applied)$")
    reviewer_note: str | None = None


class WikiSuggestRequest(BaseModel):
    trigger_type: str = Field(pattern=r"^(source|note)$")
    trigger_id: str
    limit: int = Field(default=5, ge=1, le=20)


class WikiCloneDraftRequest(BaseModel):
    title: str | None = None


class WikiEvidenceRefRead(BaseModel):
    ref_type: str
    ref_id: str
    title: str
    excerpt: str | None = None


class WikiInsightCandidateRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    run_id: int
    user_id: str
    insight_type: str
    title: str
    summary: str
    evidence_refs: list[WikiEvidenceRefRead | dict]
    metadata_: dict | None = None
    status: str
    reviewer_note: str | None = None
    created_at: datetime
    updated_at: datetime


class WikiArticleDraftRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    run_id: int
    user_id: str
    title: str
    page_type: str
    summary: str | None = None
    content: str
    evidence_refs: list[WikiEvidenceRefRead | dict]
    metadata_: dict | None = None
    status: str
    reviewer_note: str | None = None
    created_at: datetime
    updated_at: datetime


class WikiMiningRunRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    status: str
    window_start: datetime | None = None
    window_end: datetime | None = None
    metadata_: dict | None = None
    created_at: datetime
    updated_at: datetime


class WikiMiningRunList(BaseModel):
    items: list[WikiMiningRunRead]
    total: int


class WikiMiningRunDetail(BaseModel):
    run: WikiMiningRunRead
    insights: list[WikiInsightCandidateRead]
    articles: list[WikiArticleDraftRead]


class WikiInsightCandidateStatusUpdate(BaseModel):
    status: str = Field(pattern=r"^(pending|accepted|rejected|converted_to_draft)$")
    reviewer_note: str | None = None


class WikiArticleDraftStatusUpdate(BaseModel):
    status: str = Field(pattern=r"^(candidate|draft|in_review|accepted|rejected|merged|applied)$")
    reviewer_note: str | None = None
    wiki_title: str | None = None
    page_type: str | None = Field(default=None, pattern=r"^(topic|entity|concept|project|comparison)$")


class WikiCandidateMergeAction(BaseModel):
    target_wiki_id: str | None = None
    reviewer_note: str | None = None


class WikiCandidateNoteConversionRead(BaseModel):
    article_id: int
    status: str
    note_title: str
    note_content: str
    metadata_: dict | None = None
