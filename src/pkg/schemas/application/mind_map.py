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
