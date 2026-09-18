from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class MindMap(Base):
    __tablename__ = "mind_maps"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    owner_type: Mapped[str] = mapped_column(String(20), nullable=False)
    owner_id: Mapped[str] = mapped_column(String, nullable=False)
    purpose: Mapped[str] = mapped_column(String(40), nullable=False)
    layout_mode: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="balanced",
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    basis_revision: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    generation_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="manual",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "owner_type",
            "owner_id",
            "purpose",
            name="uq_mind_maps_user_owner_purpose",
        ),
        CheckConstraint("version >= 1", name="ck_mind_maps_version_positive"),
        CheckConstraint(
            "owner_type IN ('source', 'asset')",
            name="ck_mind_maps_owner_type",
        ),
        CheckConstraint(
            "purpose IN ('document_overview', 'asset_outline', 'asset_reasoning')",
            name="ck_mind_maps_purpose",
        ),
        CheckConstraint(
            "(owner_type = 'source' AND purpose = 'document_overview') OR "
            "(owner_type = 'asset' AND purpose IN ('asset_outline', 'asset_reasoning'))",
            name="ck_mind_maps_owner_purpose",
        ),
        CheckConstraint(
            "layout_mode IN ('balanced', 'right')",
            name="ck_mind_maps_layout_mode",
        ),
        CheckConstraint(
            "generation_status IN ('manual', 'generating', 'ready', 'stale', 'failed')",
            name="ck_mind_maps_generation_status",
        ),
        Index("idx_mind_maps_user_id", "user_id"),
        Index("idx_mind_maps_owner", "owner_type", "owner_id"),
        Index("idx_mind_maps_generation_status", "generation_status"),
    )


class MindMapNode(Base):
    __tablename__ = "mind_map_nodes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    map_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("mind_maps.id", ondelete="CASCADE"),
        nullable=False,
    )
    display_id: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    collapsed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    node_kind: Mapped[str] = mapped_column(String(20), nullable=False, server_default="topic")
    updated_by: Mapped[str] = mapped_column(String(20), nullable=False, server_default="human")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("map_id", "id", name="uq_mind_map_nodes_map_id_id"),
        UniqueConstraint("map_id", "display_id", name="uq_mind_map_nodes_display_id"),
        ForeignKeyConstraint(
            ["map_id", "parent_id"],
            ["mind_map_nodes.map_id", "mind_map_nodes.id"],
            name="fk_mind_map_nodes_parent_same_map",
            ondelete="CASCADE",
        ),
        CheckConstraint("display_id >= 1", name="ck_mind_map_nodes_display_id_positive"),
        CheckConstraint("position >= 0", name="ck_mind_map_nodes_position_nonnegative"),
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="ck_mind_map_nodes_not_self_parent"),
        CheckConstraint(
            "node_kind IN ('topic', 'section', 'concept', 'claim', 'evidence', "
            "'block', 'knowledge', 'question')",
            name="ck_mind_map_nodes_kind",
        ),
        CheckConstraint(
            "updated_by IN ('human', 'agent', 'system')",
            name="ck_mind_map_nodes_updated_by",
        ),
        Index("idx_mind_map_nodes_map_id", "map_id"),
        Index("idx_mind_map_nodes_siblings", "map_id", "parent_id", "position"),
    )


class MindMapNodeReference(Base):
    __tablename__ = "mind_map_node_references"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    map_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("mind_maps.id", ondelete="CASCADE"),
        nullable=False,
    )
    node_id: Mapped[str] = mapped_column(String, nullable=False)
    ref_type: Mapped[str] = mapped_column(String(30), nullable=False)
    ref_id: Mapped[str] = mapped_column(String, nullable=False)
    relation: Mapped[str] = mapped_column(String(30), nullable=False)
    fragment_selector: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["map_id", "node_id"],
            ["mind_map_nodes.map_id", "mind_map_nodes.id"],
            name="fk_mind_map_node_references_node_same_map",
            ondelete="CASCADE",
        ),
        UniqueConstraint(
            "node_id",
            "ref_type",
            "ref_id",
            "relation",
            name="uq_mind_map_node_references_target_relation",
        ),
        CheckConstraint(
            "ref_type IN ('source', 'source_chunk', 'evidence', 'claim', "
            "'asset_block', 'note', 'wiki')",
            name="ck_mind_map_node_references_type",
        ),
        CheckConstraint(
            "relation IN ('derived_from', 'represents', 'supports', 'contradicts', "
            "'elaborates', 'navigates_to')",
            name="ck_mind_map_node_references_relation",
        ),
        Index("idx_mind_map_node_references_node_id", "node_id"),
        Index("idx_mind_map_node_references_target", "ref_type", "ref_id"),
    )


class MindMapRevision(Base):
    __tablename__ = "mind_map_revisions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    map_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("mind_maps.id", ondelete="CASCADE"),
        nullable=False,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_type: Mapped[str] = mapped_column(String(20), nullable=False)
    actor_ref: Mapped[str | None] = mapped_column(String)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("map_id", "version", name="uq_mind_map_revisions_version"),
        CheckConstraint("version >= 1", name="ck_mind_map_revisions_version_positive"),
        CheckConstraint(
            "actor_type IN ('human', 'agent', 'system')",
            name="ck_mind_map_revisions_actor_type",
        ),
        CheckConstraint(
            "action IN ('map_created', 'map_updated', 'outline_applied', 'node_added', "
            "'node_updated', 'node_moved', 'node_deleted', 'reference_added', "
            "'reference_updated', 'reference_deleted', 'restored')",
            name="ck_mind_map_revisions_action",
        ),
        Index("idx_mind_map_revisions_map_created", "map_id", "created_at"),
    )
