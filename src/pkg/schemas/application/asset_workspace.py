from datetime import datetime
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator


class AssetIntentRead(BaseModel):
    revision: int = Field(ge=1)
    question: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    audience: str | None = None
    creation_mode: str = Field(min_length=1)
    scope: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    status: Literal["confirmed"] = "confirmed"
    confirmed_by: str
    confirmed_at: datetime


class AssetIntentRevisionRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    question: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    audience: str | None = None
    creation_mode: str = Field(min_length=1)
    scope: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)

    @field_validator("question", "goal", "creation_mode")
    @classmethod
    def require_non_blank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("audience")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class AssetEvidenceProposalInput(BaseModel):
    target_type: Literal["source", "note", "wiki", "web"]
    target_id: str = Field(min_length=1)
    relation: Literal["supports", "contradicts", "context", "unverified"]
    summary: str = Field(min_length=1)
    fragment_selector: dict | None = None

    @field_validator("target_id", "summary")
    @classmethod
    def require_non_blank_text(cls, value: str, info: ValidationInfo) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        if info.field_name == "target_id" and info.data.get("target_type") == "web":
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError("web evidence target_id must be an HTTP(S) URL")
        return value


class AssetEvidenceProposalBatchRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    session_id: str | None = None
    proposals: list[AssetEvidenceProposalInput] = Field(min_length=1, max_length=20)


class AssetEvidenceDecisionRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    decision: Literal["accepted", "rejected"]


class AssetEvidenceRead(BaseModel):
    id: str
    target_type: Literal["source", "note", "wiki", "web"]
    target_id: str
    relation: Literal["supports", "contradicts", "context", "unverified"]
    summary: str
    fragment_selector: dict | None = None
    status: Literal["proposed", "accepted", "rejected"]
    authorship: Literal["agent"] = "agent"
    intent_revision: int = Field(ge=1)
    source_session_id: str | None = None
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None


class AssetClaimProposalInput(BaseModel):
    content: str = Field(min_length=1)
    kind: Literal["inference", "hypothesis", "recommendation", "synthesis"]
    supporting_evidence: list[str] = Field(default_factory=list)
    contradicting_evidence: list[str] = Field(default_factory=list)
    agent_confidence: Literal["low", "medium", "high"]

    @field_validator("content")
    @classmethod
    def require_non_blank_content(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("supporting_evidence", "contradicting_evidence")
    @classmethod
    def normalize_evidence_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if item.strip()]
        return list(dict.fromkeys(normalized))


class AssetClaimProposalBatchRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    session_id: str | None = None
    proposals: list[AssetClaimProposalInput] = Field(min_length=1, max_length=20)


class AssetClaimDecisionRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    decision: Literal["accept", "edit_and_accept", "reject", "keep_as_hypothesis", "need_more_evidence"]
    edited_content: str | None = None

    @model_validator(mode="after")
    def validate_edited_content(self):
        if self.decision == "edit_and_accept":
            if not self.edited_content or not self.edited_content.strip():
                raise ValueError("edited_content is required for edit_and_accept")
            self.edited_content = self.edited_content.strip()
        elif self.edited_content is not None:
            self.edited_content = self.edited_content.strip() or None
        return self


class AssetClaimRead(BaseModel):
    id: str
    content: str
    kind: Literal["inference", "hypothesis", "recommendation", "synthesis"]
    status: Literal["proposed", "accepted", "rejected", "hypothesis", "needs_more_evidence", "superseded"]
    supporting_evidence: list[str] = Field(default_factory=list)
    contradicting_evidence: list[str] = Field(default_factory=list)
    agent_confidence: Literal["low", "medium", "high"]
    authorship: Literal["agent"] = "agent"
    intent_revision: int = Field(ge=1)
    source_session_id: str | None = None
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None
    user_edited: bool = False


class AssetContributionProposalInput(BaseModel):
    kind: Literal["user_viewpoint", "synthesis", "decision", "framework", "hypothesis", "wiki_correction"]
    summary: str = Field(min_length=1)
    claim_refs: list[str] = Field(min_length=1)

    @field_validator("summary")
    @classmethod
    def require_non_blank_summary(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("claim_refs")
    @classmethod
    def normalize_claim_refs(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if item.strip()]
        if not normalized:
            raise ValueError("must reference at least one Claim")
        return list(dict.fromkeys(normalized))


class AssetKnowledgeCandidateProposalInput(BaseModel):
    candidate_type: Literal["note", "wiki"]
    action: Literal["create", "update"]
    target_wiki_id: str | None = None
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)
    claim_refs: list[str] = Field(min_length=1)

    @field_validator("title", "content")
    @classmethod
    def require_non_blank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("claim_refs")
    @classmethod
    def normalize_claim_refs(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if item.strip()]
        if not normalized:
            raise ValueError("must reference at least one Claim")
        return list(dict.fromkeys(normalized))

    @model_validator(mode="after")
    def validate_target(self):
        if self.candidate_type == "note" and self.action != "create":
            raise ValueError("Note Candidate only supports create")
        if self.candidate_type == "note" and self.target_wiki_id is not None:
            raise ValueError("Note Candidate cannot target a Wiki")
        if self.candidate_type == "wiki" and self.action == "update":
            if not self.target_wiki_id or not self.target_wiki_id.strip():
                raise ValueError("target_wiki_id is required for Wiki update")
            self.target_wiki_id = self.target_wiki_id.strip()
        elif self.target_wiki_id is not None:
            self.target_wiki_id = self.target_wiki_id.strip() or None
        return self


class AssetKnowledgeProposalRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    session_id: str | None = None
    contribution: AssetContributionProposalInput
    candidates: list[AssetKnowledgeCandidateProposalInput] = Field(default_factory=list, max_length=10)


class AssetContributionDecisionRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    decision: Literal["accept", "edit_and_accept", "reject"]
    attribution: Literal["agent_synthesis", "user_insight"] | None = None
    edited_summary: str | None = None

    @model_validator(mode="after")
    def validate_decision(self):
        if self.decision in {"accept", "edit_and_accept"} and self.attribution is None:
            raise ValueError("attribution is required when accepting a Contribution")
        if self.decision == "edit_and_accept":
            if not self.edited_summary or not self.edited_summary.strip():
                raise ValueError("edited_summary is required for edit_and_accept")
            self.edited_summary = self.edited_summary.strip()
        elif self.edited_summary is not None:
            self.edited_summary = self.edited_summary.strip() or None
        return self


class AssetKnowledgeCandidateDecisionRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    decision: Literal["keep", "reject"]


class AssetKnowledgePromotionRequest(BaseModel):
    base_workspace_revision: int = Field(ge=0)
    confirm: Literal[True]
    confirm_overwrite: bool = False
    edited_title: str | None = None
    edited_content: str | None = None

    @field_validator("edited_title", "edited_content")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class AssetContributionRead(BaseModel):
    id: str
    kind: Literal["user_viewpoint", "synthesis", "decision", "framework", "hypothesis", "wiki_correction"]
    summary: str
    claim_refs: list[str] = Field(default_factory=list)
    status: Literal["proposed", "accepted", "rejected"]
    authorship: Literal["agent"] = "agent"
    attribution: Literal["agent_synthesis", "user_insight"] | None = None
    source_session_id: str | None = None
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None
    user_edited: bool = False


class AssetKnowledgeCandidateRead(BaseModel):
    id: str
    candidate_type: Literal["note", "wiki"]
    action: Literal["create", "update"]
    target_wiki_id: str | None = None
    title: str
    content: str
    claim_refs: list[str] = Field(default_factory=list)
    status: Literal["proposed", "kept", "rejected", "promoted"]
    authorship: Literal["agent"] = "agent"
    source_session_id: str | None = None
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None
    promoted_at: datetime | None = None
    promoted_by: str | None = None
    promoted_target_type: Literal["note", "wiki"] | None = None
    promoted_target_id: str | None = None
    user_edited: bool = False


class AssetWorkspaceRead(BaseModel):
    asset_id: str
    workspace_revision: int = Field(ge=0)
    intent: AssetIntentRead | None = None
    intent_history: list[AssetIntentRead] = Field(default_factory=list)
    evidence: list[AssetEvidenceRead] = Field(default_factory=list)
    claims: list[AssetClaimRead] = Field(default_factory=list)
    contribution: AssetContributionRead | None = None
    knowledge_candidates: list[AssetKnowledgeCandidateRead] = Field(default_factory=list)
    decision_items: list[dict] = Field(default_factory=list)
