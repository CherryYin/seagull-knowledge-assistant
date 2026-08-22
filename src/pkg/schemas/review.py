from datetime import datetime

from pydantic import BaseModel, Field


class ReviewSuggestionRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    suggestion_type: str
    target_type: str
    target_id: str
    title: str
    summary: str | None = None
    proposed_value: dict | None = None
    evidence: dict | None = None
    status: str
    metadata_: dict | None = Field(None, alias="metadata_")
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None = None
    applied_at: datetime | None = None
    reviewer_note: str | None = None


class ReviewSuggestionList(BaseModel):
    items: list[ReviewSuggestionRead]
    total: int


class ReviewSuggestionUpdate(BaseModel):
    status: str = Field(pattern=r"^(pending|accepted|rejected|dismissed|applied)$")
    reviewer_note: str | None = None


class ReviewSuggestionGenerateRequest(BaseModel):
    include_profile_suggestions: bool = True
    limit: int = Field(default=50, ge=1, le=200)


class ReviewSuggestionGenerateResult(BaseModel):
    created: int
    skipped: int
