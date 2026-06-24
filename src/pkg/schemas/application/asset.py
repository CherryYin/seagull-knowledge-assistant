from datetime import datetime

from pydantic import BaseModel, Field

ASSET_TYPE_PATTERN = r"^(blog_post|research_brief|knowledge_pack|newsletter_issue|topic_report)$"
ASSET_STATUS_PATTERN = r"^(draft|in_review|ready_to_export|exported|published|archived)$"


class AssetCreate(BaseModel):
    title: str
    brief: str | None = None
    asset_type: str = Field(default="blog_post", pattern=ASSET_TYPE_PATTERN)
    status: str = Field(default="draft", pattern=ASSET_STATUS_PATTERN)
    source_refs: list[str] = []
    note_refs: list[str] = []
    memory_refs: list[str] = []
    wiki_refs: list[str] = []
    opinion_notes: str | None = None
    style_notes: str | None = None
    metadata: dict | None = None


class RecentNewsletterCreate(BaseModel):
    title: str
    opinion_notes: str
    style_notes: str | None = None
    brief: str | None = None
    window_days: int = Field(default=2, ge=1, le=14)
    max_sources: int = Field(default=12, ge=1, le=50)
    status: str = Field(default="draft", pattern=ASSET_STATUS_PATTERN)


class AssetUpdate(BaseModel):
    title: str | None = None
    brief: str | None = None
    outline: str | None = None
    draft_content: str | None = None
    reference_notes: str | None = None
    editor_feedback: str | None = None
    status: str | None = Field(default=None, pattern=ASSET_STATUS_PATTERN)
    source_refs: list[str] | None = None
    note_refs: list[str] | None = None
    memory_refs: list[str] | None = None
    wiki_refs: list[str] | None = None
    opinion_notes: str | None = None
    style_notes: str | None = None
    export_format: str | None = None
    metadata: dict | None = None


class AssetRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    asset_type: str
    status: str
    title: str
    brief: str | None = None
    outline: str | None = None
    draft_content: str | None = None
    reference_notes: str | None = None
    editor_feedback: str | None = None
    source_refs: list[str]
    note_refs: list[str]
    memory_refs: list[str]
    wiki_refs: list[str]
    opinion_notes: str | None = None
    style_notes: str | None = None
    export_format: str | None = None
    exported_at: datetime | None = None
    published_at: datetime | None = None
    metadata_: dict | None = None
    created_at: datetime
    updated_at: datetime


class AssetList(BaseModel):
    items: list[AssetRead]
    total: int


class GenerateOutlineRequest(BaseModel):
    regenerate: bool = False


class GenerateDraftRequest(BaseModel):
    regenerate: bool = False


class AttachReferencesRequest(BaseModel):
    include_reference_notes: bool = True


class ReadinessCheckResult(BaseModel):
    ready: bool
    blocking_reasons: list[str] = []
    warning_reasons: list[str] = []
    suggestion_reasons: list[str] = []


class AssetExportResult(BaseModel):
    asset_id: str
    export_format: str
    content: str


class AssetPublishFeedbackUpdate(BaseModel):
    publish_url: str | None = None
    channel: str | None = None
    published_at: datetime | None = None
    feedback: str | None = None


class AssetFeedbackNoteResult(BaseModel):
    asset_id: str
    note_id: str
