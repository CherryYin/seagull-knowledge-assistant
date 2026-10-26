from datetime import datetime
from decimal import Decimal
import hashlib
import re
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class PodcastConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["qwen"] = "qwen"
    region: Literal["cn-beijing"] = "cn-beijing"
    model: Literal["qwen3-tts-flash"] = "qwen3-tts-flash"
    voice_id: str = Field(default="Cherry", min_length=1, max_length=120)
    target_duration_minutes: int = Field(default=6, ge=1, le=30, strict=True)
    information_cutoff_at: AwareDatetime | None = None


class PodcastConfigurationUpdate(PodcastConfiguration):
    base_revision: int = Field(ge=1, strict=True)


class PodcastConfigurationRead(PodcastConfiguration):
    model_config = ConfigDict(from_attributes=True)

    asset_id: str
    revision: int
    created_at: datetime
    updated_at: datetime


class PodcastState(BaseModel):
    asset_id: str
    configuration: PodcastConfigurationRead
    script_approval_available: Literal[True] = True
    audio_generation_available: bool = False


class PodcastVoice(BaseModel):
    id: str
    name: str
    gender: Literal["男声", "女声"]
    languages: list[str]


class PodcastVoiceCatalog(BaseModel):
    provider: Literal["qwen"] = "qwen"
    region: Literal["cn-beijing"] = "cn-beijing"
    model: Literal["qwen3-tts-flash"] = "qwen3-tts-flash"
    source: str
    checked_on: str
    items: list[PodcastVoice]


class PodcastDraftFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    brief: str = Field(default="", max_length=10000)
    outline: str = Field(default="", max_length=20000)
    draft_content: str = Field(default="", max_length=80000)
    source_refs: list[str] = Field(default_factory=list, max_length=20)
    note_refs: list[str] = Field(default_factory=list, max_length=20)
    wiki_refs: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_materials(self):
        groups = (self.source_refs, self.note_refs, self.wiki_refs)
        if sum(map(len, groups)) > 20 or any(len(set(group)) != len(group) for group in groups):
            raise ValueError("Select at most 20 distinct materials")
        if not self.title.strip():
            raise ValueError("Title must not be blank")
        return self


class PodcastMaterialReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["source", "note", "wiki"]
    id: str = Field(min_length=1, max_length=500)


class PodcastParagraphSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    paragraph_index: int = Field(ge=0, strict=True)
    text_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    material_refs: list[PodcastMaterialReference] = Field(default_factory=list, max_length=20)


def podcast_paragraphs(body: str) -> list[str]:
    normalized = "\n".join(
        line.rstrip() for line in body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    ).strip()
    return [paragraph.strip() for paragraph in re.split(r"\n{2,}", normalized) if paragraph.strip()]


class PodcastCreate(PodcastDraftFields):
    configuration: PodcastConfiguration = Field(default_factory=PodcastConfiguration)
    paragraph_sources: list[PodcastParagraphSource] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def validate_paragraph_sources(self):
        if not self.paragraph_sources:
            return self
        paragraphs = podcast_paragraphs(self.draft_content)
        if len(paragraphs) != len(self.paragraph_sources):
            raise ValueError("Paragraph sources must cover the current script in order")
        allowed = {
            (kind, material_id)
            for kind in ("source", "note", "wiki")
            for material_id in getattr(self, f"{kind}_refs")
        }
        for position, (paragraph, mapping) in enumerate(zip(paragraphs, self.paragraph_sources)):
            if (
                mapping.paragraph_index != position
                or mapping.text_hash != hashlib.sha256(paragraph.encode()).hexdigest()
            ):
                raise ValueError("Paragraph sources no longer match the script; review them again")
            refs = [(reference.kind, reference.id) for reference in mapping.material_refs]
            if len(refs) != len(set(refs)) or not set(refs) <= allowed:
                raise ValueError("Paragraph sources may only reference distinct selected materials")
        return self


class PodcastDraftUpdate(PodcastCreate):
    base_input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class PodcastApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class PodcastApprovalRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    asset_id: str
    config_revision: int
    script_hash: str
    input_hash: str
    spoken_text: str
    source_snapshot: list[dict]
    config_snapshot: dict
    approved_by: str
    created_at: datetime


class PodcastDraft(PodcastDraftFields):
    asset_id: str
    status: str
    configuration: PodcastConfigurationRead
    input_hash: str
    spoken_text: str
    materials: list[dict]
    approval_status: Literal["unconfirmed", "current", "stale"]
    latest_approval: PodcastApprovalRead | None = None
    approval_issues: list[str]
    audio_generation_available: bool = False
    paragraph_sources: list[PodcastParagraphSource] = Field(default_factory=list)


class PodcastAudioPreflightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    budget_limit: Decimal = Field(gt=0, le=2, max_digits=5, decimal_places=4)
    credential_id: int | None = Field(default=None, gt=0, strict=True)
    price_per_10k_characters: Decimal | None = Field(
        default=None, gt=0, le=10000, max_digits=11, decimal_places=6
    )


class PodcastAudioPreflightIssue(BaseModel):
    code: str
    message: str


class PodcastAudioSegmentPlan(BaseModel):
    position: int
    spoken_text: str
    text_hash: str
    character_count: int
    reserved_character_count: int
    estimated_cost: Decimal | None


class PodcastAudioPreflight(BaseModel):
    asset_id: str
    input_hash: str
    script_approval_id: str
    script_hash: str
    configuration: PodcastConfiguration
    credential_id: int | None
    credential_label: str | None
    credential_checks_passed: bool
    budget_limit: Decimal
    currency: Literal["CNY"] = "CNY"
    price_per_10k_characters: Decimal | None
    pricing_source: Literal["user_entered"] | None
    pricing_verified: Literal[False] = False
    character_count: int
    reserved_character_count: int
    segmentation_version: Literal["utf16-300-double-reserve-v3"] = "utf16-300-double-reserve-v3"
    segments: list[PodcastAudioSegmentPlan]
    estimated_cost: Decimal | None
    budget_sufficient: bool | None
    active_render_id: str | None
    active_render_status: str | None
    checks_passed: bool
    issues: list[PodcastAudioPreflightIssue]
    warnings: list[str]
    checked_at: datetime
    audio_generation_available: bool = False
    execution_fingerprint: str
    pricing_policy_id: str
    pricing_policy_current: bool


class PodcastAudioRenderRequest(PodcastAudioPreflightRequest):
    idempotency_key: str = Field(min_length=8, max_length=120, pattern=r"^[A-Za-z0-9_-]+$")
    execution_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    authorize_text_to_provider: Literal[True]
    acknowledge_billing_uncertainty: Literal[True]


class PodcastAudioFailure(BaseModel):
    stage: str
    code: str
    elapsed_ms: int = Field(ge=0)
    http_status: int | None = None
    provider_request_id: str | None = None
    exception_type: str | None = None
    provider_error_code: str | None = None
    retry_after_seconds: int | None = Field(default=None, ge=0, le=604800)


class PodcastAudioAttemptRead(BaseModel):
    id: str
    segment_position: int
    status: str
    error_code: str | None
    provider_request_id: str | None
    billable_characters: int | None
    started_at: datetime
    completed_at: datetime | None
    failure_details: PodcastAudioFailure | None = None


class PodcastAudioAbandonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    acknowledge_billing_uncertainty: Literal[True]
    acknowledge_full_regeneration: Literal[True]


class PodcastAudioAbandonment(BaseModel):
    abandoned_by: str
    abandoned_at: datetime
    previous_status: Literal["outcome_unknown", "failed", "canceled"]
    acknowledge_billing_uncertainty: Literal[True]
    acknowledge_full_regeneration: Literal[True]


class PodcastAudioRenderRead(BaseModel):
    id: str
    asset_id: str
    script_approval_id: str
    input_hash: str
    status: str
    budget_limit: Decimal
    currency: str
    estimated_cost: Decimal | None
    duration_seconds: Decimal | None
    file_sha256: str | None
    segment_count: int
    ready_segment_count: int
    attempt_count: int
    reported_characters: int | None
    reported_cost: Decimal | None
    error_message: str | None
    failure_details: PodcastAudioFailure | None = None
    attempts: list[PodcastAudioAttemptRead] = Field(default_factory=list)
    can_abandon: bool = False
    abandonment: PodcastAudioAbandonment | None = None
    created_at: datetime
    completed_at: datetime | None
