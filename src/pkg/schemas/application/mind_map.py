from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


MindMapOwnerType = Literal["source", "asset"]
MindMapPurpose = Literal["document_overview", "asset_outline", "asset_reasoning"]
MindMapLayoutMode = Literal["balanced", "right"]
MindMapGenerationStatus = Literal["manual", "generating", "ready", "stale", "failed"]
MindMapNodeKind = Literal["topic", "section", "concept", "claim", "evidence", "block", "knowledge", "question"]
MindMapUpdatedBy = Literal["human", "agent", "system"]
MindMapReferenceType = Literal["source", "source_chunk", "evidence", "claim", "asset_block", "note", "wiki"]
MindMapReferenceRelation = Literal["derived_from", "represents", "supports", "contradicts", "elaborates", "navigates_to"]
MindMapActorType = Literal["human", "agent", "system"]
MindMapRevisionAction = Literal[
    "map_created",
    "map_updated",
    "outline_applied",
    "node_added",
    "node_updated",
    "node_moved",
    "node_deleted",
    "reference_added",
    "reference_updated",
    "reference_deleted",
    "restored",
]
MindMapOutlineMode = Literal["merge", "replace"]
SOURCE_MIND_MAP_PROPOSAL_MAX_NODES = 80
SOURCE_MIND_MAP_FACTUAL_NODE_KINDS = {"claim", "evidence", "knowledge"}


class SourceMindMapBasis(BaseModel):
    source_content_hash: str | None = Field(default=None, max_length=128)
    chunk_count: int = Field(ge=0)
    chunk_revision: int | None = Field(default=None, ge=0)


class SourceMindMapGenerationSource(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    source_type: Literal["pdf"]
    ingested_at: datetime


class SourceMindMapSectionSummary(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=2000)
    chunk_ids: list[int] = Field(min_length=1, max_length=50)


class SourceMindMapChunkSummary(BaseModel):
    chunk_id: int = Field(ge=1)
    chunk_index: int = Field(ge=0)
    summary: str = Field(min_length=1, max_length=1200)
    page: int | None = Field(default=None, ge=1)


class SourceMindMapInputSummary(BaseModel):
    section_summaries: list[SourceMindMapSectionSummary] = Field(default_factory=list, max_length=40)
    chunk_summaries: list[SourceMindMapChunkSummary] = Field(min_length=1, max_length=120)


class SourceMindMapSamplingRead(BaseModel):
    strategy: Literal["all_chunks", "evenly_spaced"]
    total_chunk_count: int = Field(ge=1)
    sampled_chunk_count: int = Field(ge=1)
    omitted_chunk_count: int = Field(ge=0)
    coverage_percent: int = Field(ge=1, le=100)
    max_sampled_chunks: int = Field(ge=1)
    section_count: int = Field(ge=1)


class SourceMindMapGenerationContextRead(BaseModel):
    source_id: str
    source_metadata: SourceMindMapGenerationSource
    basis_revision: SourceMindMapBasis
    sampling: SourceMindMapSamplingRead
    input_summary: SourceMindMapInputSummary


class SourceMindMapProposalNode(BaseModel):
    temp_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    parent_temp_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    position: int = Field(ge=0)
    content: str = Field(min_length=1, max_length=2000)
    note: str | None = Field(default=None, max_length=10000)
    node_kind: MindMapNodeKind = "topic"

    @field_validator("temp_id", "parent_temp_id", "content", "note")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


class SourceMindMapFragmentSelector(BaseModel):
    page: int | None = Field(default=None, ge=1)
    quote: str | None = Field(default=None, min_length=1, max_length=500)

    @field_validator("quote")
    @classmethod
    def normalize_quote(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def require_selector(self):
        if self.page is None and self.quote is None:
            raise ValueError("fragment selector requires page or quote")
        return self


class SourceMindMapProposalReference(BaseModel):
    node_temp_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    chunk_id: int = Field(ge=1)
    relation: MindMapReferenceRelation = "derived_from"
    fragment_selector: SourceMindMapFragmentSelector | None = None

    @field_validator("node_temp_id")
    @classmethod
    def normalize_node_temp_id(cls, value: str) -> str:
        return value.strip()


class SourceMindMapProposal(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    layout_mode: MindMapLayoutMode = "balanced"
    nodes: list[SourceMindMapProposalNode] = Field(
        min_length=1,
        max_length=SOURCE_MIND_MAP_PROPOSAL_MAX_NODES,
    )
    references: list[SourceMindMapProposalReference] = Field(default_factory=list)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_proposal_contract(self):
        node_by_id = {node.temp_id: node for node in self.nodes}
        if len(node_by_id) != len(self.nodes):
            raise ValueError("proposal contains duplicate node temp IDs")
        roots = [node for node in self.nodes if node.parent_temp_id is None]
        if len(roots) != 1:
            raise ValueError("proposal must contain exactly one root node")
        if roots[0].node_kind != "topic":
            raise ValueError("proposal root node must use node_kind topic")

        sibling_positions: set[tuple[str | None, int]] = set()
        for node in self.nodes:
            sibling_position = (node.parent_temp_id, node.position)
            if sibling_position in sibling_positions:
                raise ValueError("proposal sibling positions must be unique")
            sibling_positions.add(sibling_position)
            if node.parent_temp_id is not None and node.parent_temp_id not in node_by_id:
                raise ValueError(f"proposal node {node.temp_id} references a missing parent")
            visited: set[str] = set()
            current = node
            while current.parent_temp_id is not None:
                if current.temp_id in visited:
                    raise ValueError("proposal contains a cycle")
                visited.add(current.temp_id)
                current = node_by_id[current.parent_temp_id]

        reference_keys: set[tuple[str, int, str]] = set()
        referenced_node_ids: set[str] = set()
        for reference in self.references:
            if reference.node_temp_id not in node_by_id:
                raise ValueError("proposal reference targets a missing node")
            key = (reference.node_temp_id, reference.chunk_id, reference.relation)
            if key in reference_keys:
                raise ValueError("proposal contains a duplicate reference")
            reference_keys.add(key)
            referenced_node_ids.add(reference.node_temp_id)

        missing_factual_references = sorted(
            node.temp_id
            for node in self.nodes
            if node.node_kind in SOURCE_MIND_MAP_FACTUAL_NODE_KINDS
            and node.temp_id not in referenced_node_ids
        )
        if missing_factual_references:
            raise ValueError(
                "factual proposal nodes require source chunk references: "
                + ", ".join(missing_factual_references)
            )
        return self


class SourceMindMapProposalValidate(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    basis_revision: SourceMindMapBasis
    proposal: SourceMindMapProposal
    map_id: str | None = Field(default=None, min_length=1, max_length=200)
    base_version: int | None = Field(default=None, ge=1)
    target_node_id: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("source_id", "map_id", "target_node_id")
    @classmethod
    def normalize_source_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def require_branch_target_version(self):
        if self.target_node_id is not None and (self.map_id is None or self.base_version is None):
            raise ValueError("branch proposals require map_id, base_version, and target_node_id")
        return self


class SourceMindMapProposalApply(SourceMindMapProposalValidate):
    session_id: str | None = Field(default=None, min_length=1, max_length=200)
    confirm: bool

    @field_validator("session_id")
    @classmethod
    def normalize_optional_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def require_explicit_confirmation_and_version_pair(self):
        if not self.confirm:
            raise ValueError("confirm=true is required to apply a Source Mind Map proposal")
        if (self.map_id is None) != (self.base_version is None):
            raise ValueError("map_id and base_version must be supplied together")
        return self


class SourceMindMapProposalValidationRead(BaseModel):
    source_id: str
    basis_revision: SourceMindMapBasis
    proposal: SourceMindMapProposal
    map_id: str | None = None
    base_version: int | None = None
    target_node_id: str | None = None
    node_count: int = Field(ge=1, le=SOURCE_MIND_MAP_PROPOSAL_MAX_NODES)
    reference_count: int = Field(ge=0)


class MindMapCreate(BaseModel):
    owner_type: MindMapOwnerType
    owner_id: str = Field(min_length=1, max_length=200)
    purpose: MindMapPurpose
    title: str = Field(min_length=1, max_length=300)
    root_content: str | None = Field(default=None, max_length=2000)
    root_kind: MindMapNodeKind = "topic"
    layout_mode: MindMapLayoutMode = "balanced"
    basis_revision: dict[str, Any] = Field(default_factory=dict)

    @field_validator("owner_id", "title", "root_content")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_owner_purpose(self):
        expected_owner = "source" if self.purpose == "document_overview" else "asset"
        if self.owner_type != expected_owner:
            raise ValueError(f"purpose {self.purpose} requires owner_type {expected_owner}")
        return self


class MindMapUpdate(BaseModel):
    base_version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    layout_mode: MindMapLayoutMode | None = None

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def require_change(self):
        if not (self.model_fields_set - {"base_version"}):
            raise ValueError("at least one map field must be provided")
        return self


class MindMapVersionedRequest(BaseModel):
    base_version: int = Field(ge=1)


class MindMapDelete(MindMapVersionedRequest):
    confirm: Literal[True]


class MindMapNodeCreate(MindMapVersionedRequest):
    parent_id: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=2000)
    note: str | None = Field(default=None, max_length=10000)
    position: int | None = Field(default=None, ge=0)
    node_kind: MindMapNodeKind = "topic"
    updated_by: MindMapUpdatedBy = "human"

    @field_validator("parent_id", "content", "note")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


class MindMapNodeUpdate(MindMapVersionedRequest):
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    note: str | None = Field(default=None, max_length=10000)
    node_kind: MindMapNodeKind | None = None
    updated_by: MindMapUpdatedBy = "human"

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @field_validator("note")
    @classmethod
    def normalize_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @model_validator(mode="after")
    def require_change(self):
        if not (self.model_fields_set - {"base_version", "updated_by"}):
            raise ValueError("at least one node field must be provided")
        return self


class MindMapNodeMove(MindMapVersionedRequest):
    parent_id: str = Field(min_length=1, max_length=200)
    position: int = Field(ge=0)
    updated_by: MindMapUpdatedBy = "human"

    @field_validator("parent_id")
    @classmethod
    def normalize_parent_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


class MindMapNodeDelete(MindMapVersionedRequest):
    delete_subtree: Literal[True] = True
    updated_by: MindMapUpdatedBy = "human"


class MindMapReferenceCreate(MindMapVersionedRequest):
    ref_type: MindMapReferenceType
    ref_id: str = Field(min_length=1, max_length=200)
    relation: MindMapReferenceRelation
    fragment_selector: dict[str, Any] | None = None
    updated_by: MindMapUpdatedBy = "human"

    @field_validator("ref_id")
    @classmethod
    def normalize_ref_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


class MindMapReferenceUpdate(MindMapVersionedRequest):
    relation: MindMapReferenceRelation | None = None
    fragment_selector: dict[str, Any] | None = None
    updated_by: MindMapUpdatedBy = "human"

    @model_validator(mode="after")
    def require_change(self):
        if not (self.model_fields_set - {"base_version", "updated_by"}):
            raise ValueError("at least one reference field must be provided")
        return self


class MindMapReferenceDelete(MindMapVersionedRequest):
    updated_by: MindMapUpdatedBy = "human"


class MindMapOutlineApply(MindMapVersionedRequest):
    mode: MindMapOutlineMode = "merge"
    outline: str = Field(min_length=1, max_length=100000)
    confirm_replace: bool = False
    updated_by: MindMapUpdatedBy = "human"

    @field_validator("outline")
    @classmethod
    def normalize_outline(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @model_validator(mode="after")
    def require_replace_confirmation(self):
        if self.mode == "replace" and not self.confirm_replace:
            raise ValueError("replace mode requires confirm_replace=true")
        return self


class MindMapRevisionRestore(MindMapVersionedRequest):
    confirm: Literal[True]


class MindMapRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    owner_type: MindMapOwnerType
    owner_id: str
    purpose: MindMapPurpose
    title: str
    root_node_id: str
    layout_mode: MindMapLayoutMode
    version: int = Field(ge=1)
    basis_revision: dict[str, Any] = Field(default_factory=dict)
    generation_status: MindMapGenerationStatus
    created_at: datetime
    updated_at: datetime


class MindMapList(BaseModel):
    items: list[MindMapRead] = Field(default_factory=list)
    total: int = Field(ge=0)


class MindMapStalenessRead(BaseModel):
    map: MindMapRead
    stale: bool
    reasons: list[Literal["source_content_hash", "chunk_count", "chunk_revision"]] = Field(default_factory=list)
    current_basis: dict[str, Any] = Field(default_factory=dict)


class MindMapNodeRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    map_id: str
    display_id: int = Field(ge=1)
    parent_id: str | None
    content: str
    note: str | None = None
    position: int = Field(ge=0)
    collapsed: bool = False
    node_kind: MindMapNodeKind
    updated_by: MindMapUpdatedBy
    created_at: datetime
    updated_at: datetime


class MindMapReferenceRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    map_id: str
    node_id: str
    ref_type: MindMapReferenceType
    ref_id: str
    relation: MindMapReferenceRelation
    fragment_selector: dict[str, Any] | None = None
    created_at: datetime


class MindMapReferenceList(BaseModel):
    items: list[MindMapReferenceRead] = Field(default_factory=list)
    total: int = Field(ge=0)


class MindMapTreeRead(BaseModel):
    map: MindMapRead
    root_id: str
    nodes: list[MindMapNodeRead]
    references: list[MindMapReferenceRead] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_tree_contract(self):
        node_by_id = {node.id: node for node in self.nodes}
        if len(node_by_id) != len(self.nodes):
            raise ValueError("tree contains duplicate node IDs")
        display_ids = {node.display_id for node in self.nodes}
        if len(display_ids) != len(self.nodes):
            raise ValueError("tree contains duplicate display IDs")
        roots = [node for node in self.nodes if node.parent_id is None]
        if len(roots) != 1:
            raise ValueError("tree must contain exactly one root node")
        if roots[0].id != self.root_id or self.map.root_node_id != self.root_id:
            raise ValueError("tree root does not match root_id")

        for node in self.nodes:
            if node.map_id != self.map.id:
                raise ValueError("node belongs to a different map")
            if node.parent_id is not None and node.parent_id not in node_by_id:
                raise ValueError(f"node {node.id} references a missing parent")
            visited: set[str] = set()
            current = node
            while current.parent_id is not None:
                if current.id in visited:
                    raise ValueError("tree contains a cycle")
                visited.add(current.id)
                current = node_by_id[current.parent_id]

        for reference in self.references:
            if reference.map_id != self.map.id:
                raise ValueError("reference belongs to a different map")
            if reference.node_id not in node_by_id:
                raise ValueError("reference targets a missing node")
        return self


class MindMapSnapshotRead(BaseModel):
    map: MindMapRead
    nodes: list[MindMapNodeRead]
    references: list[MindMapReferenceRead] = Field(default_factory=list)


class MindMapRevisionRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    map_id: str
    version: int = Field(ge=1)
    actor_type: MindMapActorType
    actor_ref: str | None = None
    action: MindMapRevisionAction
    summary: str
    snapshot: MindMapSnapshotRead
    created_at: datetime


class MindMapRevisionList(BaseModel):
    items: list[MindMapRevisionRead] = Field(default_factory=list)
    total: int = Field(ge=0)


class MindMapMutationResult(BaseModel):
    map_id: str
    previous_version: int = Field(ge=1)
    current_version: int = Field(ge=1)
    revision: MindMapRevisionRead
    node: MindMapNodeRead | None = None
    reference: MindMapReferenceRead | None = None
    deleted_node_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_version_increment(self):
        if self.current_version != self.previous_version + 1:
            raise ValueError("content mutation must increment the map version exactly once")
        if self.revision.map_id != self.map_id or self.revision.version != self.current_version:
            raise ValueError("revision does not match the mutation result")
        return self


class MindMapOutlineApplyResult(MindMapMutationResult):
    mode: MindMapOutlineMode
    created_count: int = Field(ge=0)
    updated_count: int = Field(ge=0)
    moved_count: int = Field(ge=0)
    deleted_count: int = Field(ge=0)


class MindMapVersionConflictDetail(BaseModel):
    code: Literal["mind_map_version_conflict"] = "mind_map_version_conflict"
    message: str
    map_id: str
    expected_version: int = Field(ge=1)
    current_version: int = Field(ge=1)


class MindMapVersionConflictResponse(BaseModel):
    detail: MindMapVersionConflictDetail
