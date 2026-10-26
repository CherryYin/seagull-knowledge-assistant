from datetime import datetime

from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator
from pkg.schemas.application.podcast import PodcastDraftFields

ASSET_TYPE_PATTERN = r"^(blog_post|research_brief|knowledge_pack|newsletter_issue|topic_report|podcast)$"
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

    @model_validator(mode="after")
    def validate_podcast_draft(self) -> Self:
        if self.asset_type == "podcast":
            PodcastDraftFields.model_validate({
                name: getattr(self, name) or ([] if name.endswith("_refs") else "")
                for name in PodcastDraftFields.model_fields
            })
        return self


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


AssetVisualRole = Literal["cover", "social_square", "social_portrait", "inline_illustration"]


def _validate_visual_context(role: AssetVisualRole, source_block_ids: list[str]) -> None:
    if role == "inline_illustration" and not source_block_ids:
        raise ValueError("inline_illustration visuals require at least one source_block_id")


class AssetVisualGenerateRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=4000)
    role: AssetVisualRole = "cover"
    size: Literal["1024*1024", "1280*720", "720*1280"] = "1280*720"
    parent_visual_id: str | None = Field(default=None, min_length=1)
    source_block_ids: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_role_size(self) -> Self:
        if self.role == "social_square" and self.size != "1024*1024":
            raise ValueError("social_square visuals require size 1024*1024")
        if self.role == "social_portrait" and self.size != "720*1280":
            raise ValueError("social_portrait visuals require size 720*1280")
        if self.role == "inline_illustration" and self.size != "1280*720":
            raise ValueError("inline_illustration visuals require size 1280*720")
        _validate_visual_context(self.role, self.source_block_ids)
        self.source_block_ids = list(dict.fromkeys(self.source_block_ids))
        return self


AssetVisualStylePreset = Literal["editorial_technology", "minimal_abstract", "research_brief"]


class AssetVisualPlanRequest(BaseModel):
    role: AssetVisualRole = "cover"
    size: Literal["1024*1024", "1280*720", "720*1280"] = "1280*720"
    style_preset: AssetVisualStylePreset = "editorial_technology"
    instructions: str | None = Field(default=None, max_length=2000)
    parent_visual_id: str | None = Field(default=None, min_length=1)
    source_block_ids: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_role_size(self) -> Self:
        if self.role == "social_square" and self.size != "1024*1024":
            raise ValueError("social_square visuals require size 1024*1024")
        if self.role == "social_portrait" and self.size != "720*1280":
            raise ValueError("social_portrait visuals require size 720*1280")
        if self.role == "inline_illustration" and self.size != "1280*720":
            raise ValueError("inline_illustration visuals require size 1280*720")
        _validate_visual_context(self.role, self.source_block_ids)
        self.source_block_ids = list(dict.fromkeys(self.source_block_ids))
        return self


class AssetVisualBrief(BaseModel):
    concept: str = Field(min_length=1, max_length=500)
    composition: str = Field(min_length=1, max_length=1000)
    style: str = Field(min_length=1, max_length=500)
    palette: list[str] = Field(default_factory=list, max_length=8)
    must_include: list[str] = Field(default_factory=list, max_length=8)
    must_avoid: list[str] = Field(default_factory=list, max_length=12)
    title_safe_area: Literal["left", "right", "top", "bottom", "center", "none"] = "left"
    prompt: str = Field(min_length=1, max_length=4000)
    alt_text: str = Field(min_length=1, max_length=1000)


class AssetVisualStyleMemoryRead(BaseModel):
    style_preset: AssetVisualStylePreset
    sample_count: int = Field(ge=1)
    source_visual_ids: list[str] = Field(default_factory=list, max_length=5)
    palette: list[str] = Field(default_factory=list, max_length=8)
    preferred_title_safe_area: Literal["left", "right", "top", "bottom", "center", "none"] | None = None


class AssetVisualPlanRead(BaseModel):
    role: AssetVisualRole = "cover"
    size: Literal["1024*1024", "1280*720", "720*1280"] = "1280*720"
    style_preset: AssetVisualStylePreset
    planner_mode: Literal["llm", "fallback"]
    planner_model: str | None = None
    style_memory: AssetVisualStyleMemoryRead | None = None
    parent_visual_id: str | None = None
    source_block_ids: list[str] = Field(default_factory=list)
    brief: AssetVisualBrief


class AssetVisualBatchGenerateRequest(BaseModel):
    role: AssetVisualRole = "cover"
    size: Literal["1024*1024", "1280*720", "720*1280"] = "1280*720"
    style_preset: AssetVisualStylePreset = "editorial_technology"
    candidate_count: int = Field(default=2, ge=1, le=4)
    style_memory: AssetVisualStyleMemoryRead | None = None
    parent_visual_id: str | None = Field(default=None, min_length=1)
    source_block_ids: list[str] = Field(default_factory=list, max_length=8)
    brief: AssetVisualBrief

    @model_validator(mode="after")
    def validate_role_size(self) -> Self:
        if self.role == "social_square" and self.size != "1024*1024":
            raise ValueError("social_square visuals require size 1024*1024")
        if self.role == "social_portrait" and self.size != "720*1280":
            raise ValueError("social_portrait visuals require size 720*1280")
        if self.role == "inline_illustration" and self.size != "1280*720":
            raise ValueError("inline_illustration visuals require size 1280*720")
        _validate_visual_context(self.role, self.source_block_ids)
        self.source_block_ids = list(dict.fromkeys(self.source_block_ids))
        return self


class AssetVisualUpdateRequest(BaseModel):
    alt_text: str = Field(min_length=1, max_length=1000)


class AssetVisualDecisionRequest(BaseModel):
    decision: Literal["accept", "reject"]


class AssetVisualRead(BaseModel):
    id: str
    asset_id: str
    role: str
    status: str
    prompt: str
    model: str
    width: int | None = None
    height: int | None = None
    mime_type: str | None = None
    image_url: str | None = None
    download_name: str | None = None
    parent_visual_id: str | None = None
    source_block_ids: list[str] = Field(default_factory=list)
    provider_request_id: str | None = None
    error_message: str | None = None
    processing_attempts: int = 0
    next_retry_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    metadata_: dict | None = None
    created_at: datetime
    updated_at: datetime


class AssetVisualList(BaseModel):
    items: list[AssetVisualRead] = Field(default_factory=list)


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
    generate_cover_image: bool = False
    cover_review_mode: Literal["draft_only", "auto_accept"] = "draft_only"
    cover_style_profile: AssetVisualStylePreset = "editorial_technology"
    cover_candidate_count: int = Field(default=1, ge=1, le=4)
    last_generated_at: datetime | None = None
    last_asset_id: str | None = None
    last_run_at: datetime | None = None
    last_run_status: Literal["generated", "skipped"] | None = None
    last_run_reason: str | None = None
    last_news_count: int = Field(default=0, ge=0)
    last_paper_count: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_cover_policy(self) -> Self:
        if self.cover_review_mode == "auto_accept" and self.cover_candidate_count != 1:
            raise ValueError("auto_accept cover review mode requires exactly one candidate")
        return self


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
    generate_cover_image: bool = False
    cover_review_mode: Literal["draft_only", "auto_accept"] = "draft_only"
    cover_style_profile: AssetVisualStylePreset = "editorial_technology"
    cover_candidate_count: int = Field(default=1, ge=1, le=4)

    @model_validator(mode="after")
    def validate_cover_policy(self) -> Self:
        if self.cover_review_mode == "auto_accept" and self.cover_candidate_count != 1:
            raise ValueError("auto_accept cover review mode requires exactly one candidate")
        return self


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
    generate_cover_image: bool
    cover_review_mode: Literal["draft_only", "auto_accept"]
    cover_style_profile: AssetVisualStylePreset
    cover_candidate_count: int = Field(ge=1, le=4)


class NewsletterVisualRunResult(BaseModel):
    status: Literal["disabled", "queued", "failed"]
    asset_id: str | None = None
    plan: AssetVisualPlanRead | None = None
    visuals: list[AssetVisualRead] = Field(default_factory=list)
    error: str | None = None


class NewsletterAutomationRunResult(BaseModel):
    status: Literal["generated", "skipped"]
    reason: str | None = None
    news_count: int = 0
    paper_count: int = 0
    config_revision: int = Field(default=0, ge=0)
    config_snapshot: NewsletterAutomationRunSnapshot | None = None
    asset: AssetRead | None = None
    cover: NewsletterVisualRunResult | None = None
