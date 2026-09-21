from datetime import datetime

from typing import Literal

from pydantic import BaseModel, Field

ASSET_TYPE_PATTERN = r"^(blog_post|research_brief|knowledge_pack|newsletter_issue|topic_report)$"
ASSET_STATUS_PATTERN = r"^(draft|in_review|ready_to_export|exported|published|archived)$"
ASSET_STYLE_PROFILE_PATTERN = r"^(editorial_story|executive_brief|visual_digest|knowledge_atlas)$"


class AssetProvenance(BaseModel):
    origin_type: Literal["harness_session", "user"]
    origin_ref: str | None = None
    action: Literal["save", "keep", "publish"] = "save"


class AssetCreate(BaseModel):
    title: str
    brief: str | None = None
    outline: str | None = None
    draft_content: str | None = None
    asset_type: str = Field(default="blog_post", pattern=ASSET_TYPE_PATTERN)
    status: str = Field(default="draft", pattern=ASSET_STATUS_PATTERN)
    source_refs: list[str] = []
    note_refs: list[str] = []
    wiki_refs: list[str] = []
    opinion_notes: str | None = None
    style_notes: str | None = None
    style_profile_id: str | None = Field(default=None, pattern=ASSET_STYLE_PROFILE_PATTERN)
    metadata: dict | None = None
    provenance: AssetProvenance | None = None


class AssetForkRequest(BaseModel):
    title: str = Field(min_length=1)
    brief: str | None = None


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
    wiki_refs: list[str] | None = None
    opinion_notes: str | None = None
    style_notes: str | None = None
    style_profile_id: str | None = Field(default=None, pattern=ASSET_STYLE_PROFILE_PATTERN)
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
    wiki_refs: list[str]
    opinion_notes: str | None = None
    style_notes: str | None = None
    style_profile_id: str = "editorial_story"
    export_format: str | None = None
    exported_at: datetime | None = None
    published_at: datetime | None = None
    metadata_: dict | None = None
    created_at: datetime
    updated_at: datetime


class AssetList(BaseModel):
    items: list[AssetRead]
    total: int


class AssetKnowledgeLineageItem(BaseModel):
    asset_id: str
    asset_title: str
    asset_type: str
    asset_status: str
    relation: Literal["distilled", "referenced"]
    candidate_id: str | None = None
    candidate_type: Literal["note", "wiki"] | None = None
    candidate_action: Literal["create", "update"] | None = None
    claim_refs: list[str] = Field(default_factory=list)
    contribution_summary: str | None = None
    promoted_at: datetime | None = None


class AssetKnowledgeLineageList(BaseModel):
    target_type: Literal["note", "wiki"]
    target_id: str
    items: list[AssetKnowledgeLineageItem] = Field(default_factory=list)


class AttachReferencesRequest(BaseModel):
    include_reference_notes: bool = True


class ReadinessCheckResult(BaseModel):
    ready: bool
    blocking_reasons: list[str] = []
    warning_reasons: list[str] = []
    suggestion_reasons: list[str] = []


class AssetQualityFinding(BaseModel):
    id: str
    severity: Literal["P0", "P1", "P2"]
    title: str
    detail: str


class AssetQualityAuditResult(BaseModel):
    asset_id: str
    workspace_revision: int
    verdict: Literal["pass", "warn", "block"]
    score: float = Field(ge=0, le=5)
    blocking_findings: list[AssetQualityFinding] = []
    warnings: list[AssetQualityFinding] = []
    metrics: dict[str, float] = {}


class AssetStyleProfileRead(BaseModel):
    id: str
    version: int
    label: str
    description: str
    generation: dict
    presentation: dict
    diagram_policy: dict


class AssetStyleProfileList(BaseModel):
    items: list[AssetStyleProfileRead]


class AssetExportResult(BaseModel):
    asset_id: str
    export_format: str
    content: str


class AssetPublishFeedbackUpdate(BaseModel):
    publish_url: str | None = None
    channel: str | None = None
    published_at: datetime | None = None
    feedback: str | None = None


class AssetWechatRenderedDiagram(BaseModel):
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    data_url: str = Field(max_length=8_000_000)


class AssetWechatDraftRequest(BaseModel):
    author: str | None = Field(default=None, max_length=64)
    digest: str | None = Field(default=None, max_length=120)
    content_source_url: str | None = Field(default=None, max_length=500)
    thumb_media_id: str | None = Field(default=None, max_length=200)
    rendered_diagrams: list[AssetWechatRenderedDiagram] = Field(default_factory=list, max_length=20)


class AssetWechatDraftResult(BaseModel):
    asset_id: str
    media_id: str
    account_label: str
    sent_at: datetime


class AssetFeedbackNoteResult(BaseModel):
    asset_id: str
    note_id: str


class NewsletterAutomationConfig(BaseModel):
    config_revision: int = Field(default=0, ge=0)
    enabled: bool = False
    name: str = "Technology Newsletter"
    topics: list[str] = Field(default_factory=list)
    frequency: Literal["manual", "daily", "weekly"] = "weekly"
    hour_utc: int = Field(default=1, ge=0, le=23)
    weekday_utc: int = Field(default=4, ge=0, le=6)
    lookback_days: int = Field(default=7, ge=1, le=30)
    max_news_items: int = Field(default=8, ge=0, le=50)
    max_paper_items: int = Field(default=5, ge=0, le=50)
    delivery_format: Literal["markdown", "html"] = "html"
    audience: str = "Technology readers"
    style_notes: str = "Concise, evidence-led, and easy to scan."
    last_generated_at: datetime | None = None
    last_asset_id: str | None = None
    last_run_at: datetime | None = None
    last_run_status: Literal["generated", "skipped"] | None = None
    last_run_reason: str | None = None
    last_news_count: int = Field(default=0, ge=0)
    last_paper_count: int = Field(default=0, ge=0)


class NewsletterAutomationUpdate(BaseModel):
    enabled: bool
    name: str = Field(min_length=1, max_length=160)
    topics: list[str] = Field(default_factory=list, max_length=30)
    frequency: Literal["manual", "daily", "weekly"]
    hour_utc: int = Field(ge=0, le=23)
    weekday_utc: int = Field(ge=0, le=6)
    lookback_days: int = Field(ge=1, le=30)
    max_news_items: int = Field(ge=0, le=50)
    max_paper_items: int = Field(ge=0, le=50)
    delivery_format: Literal["markdown", "html"]
    audience: str = Field(default="", max_length=300)
    style_notes: str = Field(default="", max_length=2000)


class NewsletterAutomationRunSnapshot(BaseModel):
    config_revision: int = Field(ge=0)
    enabled: bool
    name: str
    topics: list[str]
    frequency: Literal["manual", "daily", "weekly"]
    hour_utc: int = Field(ge=0, le=23)
    weekday_utc: int = Field(ge=0, le=6)
    lookback_days: int = Field(ge=1, le=30)
    max_news_items: int = Field(ge=0, le=50)
    max_paper_items: int = Field(ge=0, le=50)
    delivery_format: Literal["markdown", "html"]
    audience: str
    style_notes: str


class NewsletterAutomationRunResult(BaseModel):
    status: Literal["generated", "skipped"]
    reason: str | None = None
    news_count: int = 0
    paper_count: int = 0
    config_revision: int = Field(default=0, ge=0)
    config_snapshot: NewsletterAutomationRunSnapshot | None = None
    asset: AssetRead | None = None
