import json
import re
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.application.mind_map import (
    MindMap,
    MindMapNode,
    MindMapNodeReference,
    MindMapRevision,
)
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source, SourceChunk
from pkg.models.foundation.wiki import WikiPage
from pkg.schemas.application.mind_map import (
    AssetOutlineBasis,
    AssetOutlineProposal,
    AssetOutlineRefreshApply,
    AssetOutlineRefreshProposalRead,
    MindMapCreate,
    MindMapDelete,
    MindMapNodeCreate,
    MindMapNodeDelete,
    MindMapNodeMove,
    MindMapNodeUpdate,
    MindMapOutlineApply,
    MindMapReferenceCreate,
    MindMapReferenceDelete,
    MindMapReferenceUpdate,
    MindMapRevisionRestore,
    MindMapSnapshotRead,
    SourceMindMapChunkSummary,
    SourceMindMapGenerationContextRead,
    SourceMindMapGenerationSource,
    SourceMindMapInputSummary,
    SourceMindMapProposal,
    SourceMindMapProposalApply,
    SourceMindMapProposalValidate,
    SourceMindMapSectionSummary,
    MindMapTreeRead,
    MindMapUpdate,
)


@dataclass(frozen=True)
class MindMapSummaryState:
    map: MindMap
    root_id: str


@dataclass(frozen=True)
class MindMapTreeState:
    map: MindMap
    root_id: str
    nodes: list[MindMapNode]
    references: list[MindMapNodeReference]


@dataclass(frozen=True)
class MindMapStalenessState:
    map: MindMap
    root_id: str
    stale: bool
    reasons: tuple[str, ...]
    current_basis: dict


@dataclass(frozen=True)
class SourceMindMapProposalValidationState:
    source_id: str
    basis_revision: dict
    proposal: SourceMindMapProposal
    node_count: int
    reference_count: int


@dataclass(frozen=True)
class MindMapMutationState:
    map: MindMap
    root_id: str
    previous_version: int
    current_version: int
    revision: MindMapRevision
    node: MindMapNode | None = None
    reference: MindMapNodeReference | None = None
    deleted_node_ids: tuple[str, ...] = ()
    outline_mode: str | None = None
    created_count: int = 0
    updated_count: int = 0
    moved_count: int = 0
    deleted_count: int = 0


@dataclass(frozen=True)
class ParsedMindMapOutlineNode:
    content: str
    display_id: int | None
    parent_index: int | None
    depth: int


MAX_OUTLINE_NODES = 500
OUTLINE_LINE_PATTERN = re.compile(r"^(?P<indent> *)(?:- )(?P<content>.+)$")
OUTLINE_ID_PATTERN = re.compile(r"^\[id:(?P<display_id>\d+)\]\s+(?P<content>.+)$")
SOURCE_CONTEXT_MAX_CHUNKS = 80
SOURCE_CONTEXT_CHUNK_SUMMARY_CHARS = 360
SOURCE_CONTEXT_SECTION_SUMMARY_CHARS = 240
SOURCE_CONTEXT_SECTION_SIZE = 12
SOURCE_CONTEXT_HEADING_PATTERN = re.compile(r"^#{1,6}\s+(?P<title>.+?)\s*$", re.MULTILINE)
SOURCE_MIND_MAP_AUTO_COLLAPSE_THRESHOLD = 40
SOURCE_MIND_MAP_AUTO_COLLAPSE_DEPTH = 2
ASSET_HEADING_PATTERN = re.compile(r"^(?P<marks>#{1,6})\s+(?P<title>.+?)\s*$")


def make_mind_map_id() -> str:
    return f"mind-map-{uuid.uuid4().hex[:12]}"


def make_mind_map_node_id() -> str:
    return f"mind-map-node-{uuid.uuid4().hex[:12]}"


def _base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    digits: list[str] = []
    while value:
        value, remainder = divmod(value, 36)
        digits.append(alphabet[remainder])
    return "".join(reversed(digits))


def _asset_document_signature(blocks: list[dict]) -> str:
    payload = [
        {
            "id": block["id"],
            "revision": block["revision"],
            "markdown": block["markdown"],
            "claimRefs": block.get("claim_refs", block.get("claimRefs", [])),
        }
        for block in blocks
    ]
    value = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    hash_value = 2166136261
    encoded = value.encode("utf-16-le")
    for offset in range(0, len(encoded), 2):
        code_unit = encoded[offset] | (encoded[offset + 1] << 8)
        hash_value ^= code_unit
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return f"document-{_base36(hash_value)}"


def build_asset_outline_proposal(asset: Asset) -> AssetOutlineProposal:
    metadata = asset.metadata_ or {}
    document = metadata.get("asset_document")
    if not isinstance(document, dict) or not isinstance(document.get("blocks"), list) or not document["blocks"]:
        raise HTTPException(
            status_code=409,
            detail="Save the Asset once to establish stable Blocks before creating an Outline Map",
        )
    workspace = metadata.get("asset_workspace_v1")
    intent = workspace.get("intent") if isinstance(workspace, dict) else None
    if not isinstance(intent, dict) or intent.get("status") != "confirmed" or not isinstance(intent.get("revision"), int):
        raise HTTPException(status_code=409, detail="Confirm the Asset Intent before creating an Outline Map")

    claims = workspace.get("claims", []) if isinstance(workspace, dict) else []
    reviewed_claim_ids = {
        claim.get("id")
        for claim in claims
        if isinstance(claim, dict)
        and isinstance(claim.get("id"), str)
        and claim.get("status") in {"accepted", "hypothesis"}
    }
    blocks = document["blocks"]
    proposal_nodes = [{
        "temp_id": "root",
        "parent_temp_id": None,
        "position": 0,
        "content": asset.title,
        "node_kind": "topic",
    }]
    heading_stack: dict[int, str] = {}
    child_counts: dict[str, int] = {"root": 0}
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise HTTPException(status_code=422, detail="Asset Document contains an invalid Block")
        block_id = block.get("id")
        markdown = block.get("markdown")
        revision = block.get("revision")
        claim_refs = block.get("claim_refs", block.get("claimRefs", []))
        if not isinstance(block_id, str) or not block_id.strip() or not isinstance(markdown, str) or not markdown.strip() or not isinstance(revision, int) or revision < 1:
            raise HTTPException(status_code=422, detail="Asset Document contains an invalid Block contract")
        if not isinstance(claim_refs, list) or any(not isinstance(claim_id, str) for claim_id in claim_refs):
            raise HTTPException(status_code=422, detail=f"Asset Block {block_id} has invalid Claim references")
        unknown_claim_ids = set(claim_refs) - reviewed_claim_ids
        if unknown_claim_ids:
            raise HTTPException(
                status_code=409,
                detail=f"Asset Block {block_id} references unreviewed Claims: {', '.join(sorted(unknown_claim_ids))}",
            )

        heading_match = ASSET_HEADING_PATTERN.match(markdown.strip().splitlines()[0])
        if heading_match:
            heading_level = len(heading_match.group("marks"))
            parent_candidates = [level for level in heading_stack if level < heading_level]
            parent_temp_id = heading_stack[max(parent_candidates)] if parent_candidates else "root"
            content = heading_match.group("title")
            node_kind = "section"
            heading_stack = {level: temp_id for level, temp_id in heading_stack.items() if level < heading_level}
        else:
            parent_temp_id = heading_stack[max(heading_stack)] if heading_stack else "root"
            content = _bounded_text(markdown, 180)
            node_kind = "block"
        temp_id = f"block-{index + 1}"
        position = child_counts.get(parent_temp_id, 0)
        child_counts[parent_temp_id] = position + 1
        child_counts[temp_id] = 0
        proposal_nodes.append({
            "temp_id": temp_id,
            "parent_temp_id": parent_temp_id,
            "position": position,
            "content": content,
            "node_kind": node_kind,
            "asset_block_id": block_id,
            "claim_refs": claim_refs,
        })
        if heading_match:
            heading_stack[heading_level] = temp_id

    workspace_revision = workspace.get("workspace_revision", 0) if isinstance(workspace, dict) else 0
    document_revision = document.get("revision", 0)
    return AssetOutlineProposal(
        asset_id=asset.id,
        title=f"{asset.title} · Outline",
        basis_revision=AssetOutlineBasis(
            workspace_revision=workspace_revision if isinstance(workspace_revision, int) else 0,
            intent_revision=intent["revision"],
            asset_document_revision=document_revision if isinstance(document_revision, int) and document_revision >= 0 else 0,
            base_document_signature=_asset_document_signature(blocks),
            accepted_claim_ids=sorted(reviewed_claim_ids),
        ),
        nodes=proposal_nodes,
    )


def _bounded_text(value: str, max_chars: int) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if len(normalized) <= max_chars:
        return normalized
    boundary = normalized.rfind(" ", 0, max_chars)
    if boundary < max_chars // 2:
        boundary = max_chars - 1
    return normalized[:boundary].rstrip(" ,;:-") + "…"


def _sample_source_chunks(chunks: list[SourceChunk]) -> list[SourceChunk]:
    if len(chunks) <= SOURCE_CONTEXT_MAX_CHUNKS:
        return chunks
    last_index = len(chunks) - 1
    return [
        chunks[(sample_index * last_index) // (SOURCE_CONTEXT_MAX_CHUNKS - 1)]
        for sample_index in range(SOURCE_CONTEXT_MAX_CHUNKS)
    ]


def _section_title(chunks: list[SourceChunk], segment_number: int) -> str:
    for chunk in chunks:
        match = SOURCE_CONTEXT_HEADING_PATTERN.search(chunk.content)
        if match:
            return _bounded_text(match.group("title"), 300)
    return f"Document segment {segment_number}"


async def build_source_mind_map_generation_context(
    session: AsyncSession,
    *,
    user_id: str,
    source_id: str,
) -> SourceMindMapGenerationContextRead:
    source_row = await session.execute(
        select(Source).where(Source.id == source_id, Source.user_id == user_id)
    )
    source = source_row.scalar_one_or_none()
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    if source.source_type != "pdf":
        raise HTTPException(status_code=422, detail="Source Mind Map generation requires a PDF Source")

    chunk_rows = await session.execute(
        select(SourceChunk)
        .where(SourceChunk.source_id == source.id)
        .order_by(SourceChunk.chunk_index)
    )
    chunks = list(chunk_rows.scalars().all())
    if not chunks:
        raise HTTPException(status_code=422, detail="PDF extraction must produce Source Chunks before generation")

    selected_chunks = _sample_source_chunks(chunks)
    chunk_summaries = [
        SourceMindMapChunkSummary(
            chunk_id=chunk.id,
            chunk_index=chunk.chunk_index,
            summary=_bounded_text(chunk.content, SOURCE_CONTEXT_CHUNK_SUMMARY_CHARS),
        )
        for chunk in selected_chunks
    ]
    summary_by_id = {summary.chunk_id: summary.summary for summary in chunk_summaries}
    section_summaries = []
    for start in range(0, len(selected_chunks), SOURCE_CONTEXT_SECTION_SIZE):
        section_chunks = selected_chunks[start : start + SOURCE_CONTEXT_SECTION_SIZE]
        chunk_ids = [chunk.id for chunk in section_chunks]
        section_text = " ".join(summary_by_id[chunk_id] for chunk_id in chunk_ids[:2])
        section_summaries.append(
            SourceMindMapSectionSummary(
                title=_section_title(section_chunks, len(section_summaries) + 1),
                summary=_bounded_text(section_text, SOURCE_CONTEXT_SECTION_SUMMARY_CHARS),
                chunk_ids=chunk_ids,
            )
        )

    source_metadata = source.metadata_ if isinstance(source.metadata_, dict) else {}
    sampled_chunk_count = len(selected_chunks)
    total_chunk_count = len(chunks)
    return SourceMindMapGenerationContextRead(
        source_id=source.id,
        source_metadata=SourceMindMapGenerationSource(
            title=source.title,
            source_type="pdf",
            ingested_at=source.ingested_at,
        ),
        basis_revision={
            "source_content_hash": source.content_hash,
            "chunk_count": len(chunks),
            "chunk_revision": source_metadata.get("chunk_revision"),
        },
        sampling={
            "strategy": "all_chunks" if sampled_chunk_count == total_chunk_count else "evenly_spaced",
            "total_chunk_count": total_chunk_count,
            "sampled_chunk_count": sampled_chunk_count,
            "omitted_chunk_count": total_chunk_count - sampled_chunk_count,
            "coverage_percent": round(sampled_chunk_count / total_chunk_count * 100),
            "max_sampled_chunks": SOURCE_CONTEXT_MAX_CHUNKS,
            "section_count": len(section_summaries),
        },
        input_summary=SourceMindMapInputSummary(
            section_summaries=section_summaries,
            chunk_summaries=chunk_summaries,
        ),
    )


def make_mind_map_revision_id() -> str:
    return f"mind-map-revision-{uuid.uuid4().hex[:12]}"


def make_mind_map_reference_id() -> str:
    return f"mind-map-reference-{uuid.uuid4().hex[:12]}"


def parse_mind_map_outline(outline: str) -> list[ParsedMindMapOutlineNode]:
    parsed: list[ParsedMindMapOutlineNode] = []
    parent_by_depth: dict[int, int] = {}
    seen_display_ids: set[int] = set()
    previous_depth = 0
    for line_number, raw_line in enumerate(outline.splitlines(), start=1):
        if not raw_line.strip():
            continue
        if "\t" in raw_line:
            raise HTTPException(
                status_code=422,
                detail=f"Outline line {line_number} must use spaces, not tabs",
            )
        match = OUTLINE_LINE_PATTERN.fullmatch(raw_line)
        if match is None:
            raise HTTPException(
                status_code=422,
                detail=f"Outline line {line_number} must be a '- ' list item",
            )
        indent = len(match.group("indent"))
        if indent % 2:
            raise HTTPException(
                status_code=422,
                detail=f"Outline line {line_number} indentation must use two-space levels",
            )
        depth = indent // 2
        if parsed and depth > previous_depth + 1:
            raise HTTPException(
                status_code=422,
                detail=f"Outline line {line_number} skips a parent level",
            )
        if not parsed and depth != 0:
            raise HTTPException(status_code=422, detail="Outline root must start at depth zero")
        if parsed and depth == 0:
            raise HTTPException(status_code=422, detail="Outline must contain exactly one root")

        raw_content = match.group("content").strip()
        id_match = OUTLINE_ID_PATTERN.fullmatch(raw_content)
        display_id = int(id_match.group("display_id")) if id_match else None
        content = (id_match.group("content") if id_match else raw_content).strip()
        if not content:
            raise HTTPException(status_code=422, detail=f"Outline line {line_number} is blank")
        if len(content) > 2000:
            raise HTTPException(
                status_code=422,
                detail=f"Outline line {line_number} exceeds the node content limit",
            )
        if display_id is not None:
            if display_id < 1:
                raise HTTPException(status_code=422, detail="Outline display IDs must be positive")
            if display_id in seen_display_ids:
                raise HTTPException(
                    status_code=422,
                    detail=f"Outline repeats display ID {display_id}",
                )
            seen_display_ids.add(display_id)

        parent_index = parent_by_depth.get(depth - 1) if depth else None
        if depth and parent_index is None:
            raise HTTPException(
                status_code=422,
                detail=f"Outline line {line_number} has no parent",
            )
        parsed.append(
            ParsedMindMapOutlineNode(
                content=content,
                display_id=display_id,
                parent_index=parent_index,
                depth=depth,
            )
        )
        if len(parsed) > MAX_OUTLINE_NODES:
            raise HTTPException(
                status_code=422,
                detail=f"Outline exceeds the {MAX_OUTLINE_NODES}-node limit",
            )
        parent_by_depth[depth] = len(parsed) - 1
        for stale_depth in [value for value in parent_by_depth if value > depth]:
            parent_by_depth.pop(stale_depth)
        previous_depth = depth
    if not parsed:
        raise HTTPException(status_code=422, detail="Outline must contain at least one node")
    return parsed


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="Mind Map not found")


def _invalid_tree(map_id: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"code": "mind_map_invalid_tree", "map_id": map_id, "message": message},
    )


def _validate_version(mind_map: MindMap, expected_version: int) -> None:
    if mind_map.version == expected_version:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "mind_map_version_conflict",
            "message": (
                f"Mind Map version changed: expected {expected_version}, "
                f"current {mind_map.version}"
            ),
            "map_id": mind_map.id,
            "expected_version": expected_version,
            "current_version": mind_map.version,
        },
    )


def _root_node(map_id: str, nodes: list[MindMapNode]) -> MindMapNode:
    node_by_id = {node.id: node for node in nodes}
    if len(node_by_id) != len(nodes):
        raise _invalid_tree(map_id, "Node IDs are not unique")
    if len({node.display_id for node in nodes}) != len(nodes):
        raise _invalid_tree(map_id, "Display IDs are not unique")
    roots = [node for node in nodes if node.parent_id is None]
    if len(roots) != 1:
        raise _invalid_tree(map_id, f"Expected exactly one root node, found {len(roots)}")
    for node in nodes:
        if node.map_id != map_id:
            raise _invalid_tree(map_id, f"Node {node.id} belongs to another Map")
        visited: set[str] = set()
        current = node
        while current.parent_id is not None:
            if current.id in visited:
                raise _invalid_tree(map_id, f"Cycle detected at node {current.id}")
            visited.add(current.id)
            parent = node_by_id.get(current.parent_id)
            if parent is None:
                raise _invalid_tree(map_id, f"Node {current.id} references a missing parent")
            current = parent
    return roots[0]


def _node_by_id(map_id: str, nodes: list[MindMapNode], node_id: str) -> MindMapNode:
    node = next((candidate for candidate in nodes if candidate.id == node_id), None)
    if node is None:
        raise HTTPException(status_code=404, detail="Mind Map node not found")
    if node.map_id != map_id:
        raise HTTPException(status_code=404, detail="Mind Map node not found")
    return node


def _subtree_ids(nodes: list[MindMapNode], node_id: str) -> set[str]:
    children: dict[str, list[str]] = {}
    for node in nodes:
        if node.parent_id is not None:
            children.setdefault(node.parent_id, []).append(node.id)
    descendants: set[str] = set()
    pending = [node_id]
    while pending:
        current = pending.pop()
        if current in descendants:
            continue
        descendants.add(current)
        pending.extend(children.get(current, []))
    return descendants


def _ordered_siblings(
    nodes: list[MindMapNode],
    parent_id: str | None,
    *,
    exclude_id: str | None = None,
) -> list[MindMapNode]:
    return sorted(
        (
            node
            for node in nodes
            if node.parent_id == parent_id and node.id != exclude_id
        ),
        key=lambda node: (node.position, node.display_id, node.id),
    )


def _set_sibling_positions(nodes: list[MindMapNode], now: datetime) -> None:
    for position, node in enumerate(nodes):
        if node.position != position:
            node.position = position
            node.updated_at = now


def _insert_at_position(
    nodes: list[MindMapNode],
    node: MindMapNode,
    *,
    parent_id: str,
    position: int | None,
    now: datetime,
) -> None:
    old_parent_id = node.parent_id
    target_siblings = _ordered_siblings(nodes, parent_id, exclude_id=node.id)
    target_position = len(target_siblings) if position is None else position
    if target_position > len(target_siblings):
        raise HTTPException(
            status_code=422,
            detail=f"Node position {target_position} exceeds sibling count {len(target_siblings)}",
        )

    if old_parent_id is not None and old_parent_id != parent_id:
        _set_sibling_positions(
            _ordered_siblings(nodes, old_parent_id, exclude_id=node.id),
            now,
        )
    node.parent_id = parent_id
    target_siblings.insert(target_position, node)
    _set_sibling_positions(target_siblings, now)


def _serialize_datetime(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _snapshot(
    mind_map: MindMap,
    root_id: str,
    nodes: list[MindMapNode],
    references: list[MindMapNodeReference],
) -> dict:
    return {
        "map": {
            "id": mind_map.id,
            "user_id": mind_map.user_id,
            "owner_type": mind_map.owner_type,
            "owner_id": mind_map.owner_id,
            "purpose": mind_map.purpose,
            "title": mind_map.title,
            "root_node_id": root_id,
            "layout_mode": mind_map.layout_mode,
            "version": mind_map.version,
            "basis_revision": deepcopy(mind_map.basis_revision or {}),
            "generation_status": mind_map.generation_status,
            "created_at": _serialize_datetime(mind_map.created_at),
            "updated_at": _serialize_datetime(mind_map.updated_at),
        },
        "nodes": [
            {
                "id": node.id,
                "map_id": node.map_id,
                "display_id": node.display_id,
                "parent_id": node.parent_id,
                "content": node.content,
                "note": node.note,
                "position": node.position,
                "collapsed": node.collapsed,
                "node_kind": node.node_kind,
                "updated_by": node.updated_by,
                "created_at": _serialize_datetime(node.created_at),
                "updated_at": _serialize_datetime(node.updated_at),
            }
            for node in sorted(nodes, key=lambda item: item.display_id)
        ],
        "references": [
            {
                "id": reference.id,
                "map_id": reference.map_id,
                "node_id": reference.node_id,
                "ref_type": reference.ref_type,
                "ref_id": reference.ref_id,
                "relation": reference.relation,
                "fragment_selector": deepcopy(reference.fragment_selector),
                "created_at": _serialize_datetime(reference.created_at),
            }
            for reference in sorted(references, key=lambda item: item.id)
        ],
    }


async def _validate_owner(
    session: AsyncSession,
    *,
    user_id: str,
    owner_type: str,
    owner_id: str,
) -> None:
    model = Source if owner_type == "source" else Asset
    row = await session.execute(
        select(model.id).where(model.id == owner_id, model.user_id == user_id)
    )
    if row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail=f"{owner_type.title()} owner not found")


async def _get_map_for_update(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> MindMap:
    row = await session.execute(
        select(MindMap)
        .where(MindMap.id == map_id, MindMap.user_id == user_id)
        .with_for_update()
    )
    mind_map = row.scalar_one_or_none()
    if mind_map is None:
        raise _not_found()
    return mind_map


async def _get_map(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> MindMap:
    row = await session.execute(
        select(MindMap).where(MindMap.id == map_id, MindMap.user_id == user_id)
    )
    mind_map = row.scalar_one_or_none()
    if mind_map is None:
        raise _not_found()
    return mind_map


async def _load_nodes(
    session: AsyncSession,
    *,
    map_id: str,
    for_update: bool = False,
) -> list[MindMapNode]:
    statement = (
        select(MindMapNode)
        .where(MindMapNode.map_id == map_id)
        .order_by(MindMapNode.display_id)
    )
    if for_update:
        statement = statement.with_for_update()
    rows = await session.execute(statement)
    return list(rows.scalars().all())


async def _load_references(
    session: AsyncSession,
    *,
    map_id: str,
) -> list[MindMapNodeReference]:
    rows = await session.execute(
        select(MindMapNodeReference)
        .where(MindMapNodeReference.map_id == map_id)
        .order_by(MindMapNodeReference.id)
    )
    return list(rows.scalars().all())


async def _validate_reference_target(
    session: AsyncSession,
    *,
    user_id: str,
    mind_map: MindMap,
    ref_type: str,
    ref_id: str,
) -> None:
    found = False
    if ref_type in {"source", "note", "wiki"}:
        model = {"source": Source, "note": Note, "wiki": WikiPage}[ref_type]
        row = await session.execute(
            select(model.id).where(model.id == ref_id, model.user_id == user_id)
        )
        found = row.scalar_one_or_none() is not None
    elif ref_type == "source_chunk":
        try:
            chunk_id = int(ref_id)
        except ValueError:
            chunk_id = None
        if chunk_id is not None and str(chunk_id) == ref_id:
            row = await session.execute(
                select(SourceChunk.id)
                .join(Source, Source.id == SourceChunk.source_id)
                .where(SourceChunk.id == chunk_id, Source.user_id == user_id)
            )
            found = row.scalar_one_or_none() is not None
    else:
        if mind_map.owner_type == "asset":
            row = await session.execute(
                select(Asset).where(
                    Asset.id == mind_map.owner_id,
                    Asset.user_id == user_id,
                )
            )
            asset = row.scalar_one_or_none()
            if asset is not None:
                metadata = asset.metadata_ or {}
                workspace = metadata.get("asset_workspace_v1")
                workspace = workspace if isinstance(workspace, dict) else {}
                if ref_type == "evidence":
                    candidates = workspace.get("evidence")
                elif ref_type == "claim":
                    candidates = workspace.get("claims")
                else:
                    document = metadata.get("asset_document")
                    document = document if isinstance(document, dict) else {}
                    candidates = document.get("blocks")
                found = any(
                    isinstance(candidate, dict) and candidate.get("id") == ref_id
                    for candidate in candidates or []
                )
    if not found:
        raise HTTPException(status_code=404, detail="Mind Map reference target not found")


async def _get_reference_for_update(
    session: AsyncSession,
    *,
    map_id: str,
    node_id: str,
    reference_id: str,
) -> MindMapNodeReference:
    row = await session.execute(
        select(MindMapNodeReference)
        .where(
            MindMapNodeReference.id == reference_id,
            MindMapNodeReference.map_id == map_id,
            MindMapNodeReference.node_id == node_id,
        )
        .with_for_update()
    )
    reference = row.scalar_one_or_none()
    if reference is None:
        raise HTTPException(status_code=404, detail="Mind Map reference not found")
    return reference


async def _ensure_reference_unique(
    session: AsyncSession,
    *,
    node_id: str,
    ref_type: str,
    ref_id: str,
    relation: str,
    exclude_id: str | None = None,
) -> None:
    statement = select(MindMapNodeReference.id).where(
        MindMapNodeReference.node_id == node_id,
        MindMapNodeReference.ref_type == ref_type,
        MindMapNodeReference.ref_id == ref_id,
        MindMapNodeReference.relation == relation,
    )
    if exclude_id is not None:
        statement = statement.where(MindMapNodeReference.id != exclude_id)
    row = await session.execute(statement)
    if row.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Mind Map reference already exists")


async def _record_revision(
    session: AsyncSession,
    *,
    mind_map: MindMap,
    root_id: str,
    nodes: list[MindMapNode],
    references: list[MindMapNodeReference],
    actor_type: str,
    actor_ref: str | None,
    action: str,
    summary: str,
    now: datetime,
) -> MindMapRevision:
    revision = MindMapRevision(
        id=make_mind_map_revision_id(),
        map_id=mind_map.id,
        version=mind_map.version,
        actor_type=actor_type,
        actor_ref=actor_ref,
        action=action,
        summary=summary,
        snapshot=_snapshot(mind_map, root_id, nodes, references),
        created_at=now,
    )
    session.add(revision)
    return revision


async def create_mind_map(
    session: AsyncSession,
    *,
    user_id: str,
    body: MindMapCreate,
    actor_type: str = "human",
    actor_ref: str | None = None,
) -> MindMapTreeState:
    await _validate_owner(
        session,
        user_id=user_id,
        owner_type=body.owner_type,
        owner_id=body.owner_id,
    )
    existing_row = await session.execute(
        select(MindMap.id).where(
            MindMap.user_id == user_id,
            MindMap.owner_type == body.owner_type,
            MindMap.owner_id == body.owner_id,
            MindMap.purpose == body.purpose,
        )
    )
    if existing_row.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Mind Map already exists for this owner and purpose")

    now = datetime.now(UTC)
    mind_map = MindMap(
        id=make_mind_map_id(),
        user_id=user_id,
        title=body.title,
        owner_type=body.owner_type,
        owner_id=body.owner_id,
        purpose=body.purpose,
        layout_mode=body.layout_mode,
        version=1,
        basis_revision=deepcopy(body.basis_revision),
        generation_status="manual",
        created_at=now,
        updated_at=now,
    )
    root = MindMapNode(
        id=make_mind_map_node_id(),
        map_id=mind_map.id,
        display_id=1,
        parent_id=None,
        content=body.root_content or body.title,
        note=None,
        position=0,
        collapsed=False,
        node_kind=body.root_kind,
        updated_by=actor_type,
        created_at=now,
        updated_at=now,
    )
    session.add(mind_map)
    session.add(root)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=[root],
        references=[],
        actor_type=actor_type,
        actor_ref=actor_ref,
        action="map_created",
        summary="Created Mind Map and root node",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(root)
    await session.refresh(revision)
    return MindMapTreeState(map=mind_map, root_id=root.id, nodes=[root], references=[])


async def project_asset_outline_map(
    session: AsyncSession,
    *,
    user_id: str,
    asset_id: str,
) -> MindMapTreeState:
    existing_row = await session.execute(
        select(MindMap).where(
            MindMap.user_id == user_id,
            MindMap.owner_type == "asset",
            MindMap.owner_id == asset_id,
            MindMap.purpose == "asset_outline",
        )
    )
    existing = existing_row.scalar_one_or_none()
    if existing is not None:
        return await get_mind_map_tree(session, user_id=user_id, map_id=existing.id)

    asset_row = await session.execute(select(Asset).where(Asset.id == asset_id, Asset.user_id == user_id))
    asset = asset_row.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    proposal = build_asset_outline_proposal(asset)
    now = datetime.now(UTC)
    mind_map = MindMap(
        id=make_mind_map_id(),
        user_id=user_id,
        title=proposal.title,
        owner_type="asset",
        owner_id=asset.id,
        purpose="asset_outline",
        layout_mode=proposal.layout_mode,
        version=1,
        basis_revision=proposal.basis_revision.model_dump(),
        generation_status="ready",
        created_at=now,
        updated_at=now,
    )
    node_ids = {node.temp_id: make_mind_map_node_id() for node in proposal.nodes}
    nodes = [
        MindMapNode(
            id=node_ids[node.temp_id],
            map_id=mind_map.id,
            display_id=index + 1,
            parent_id=node_ids.get(node.parent_temp_id) if node.parent_temp_id else None,
            content=node.content,
            note=None,
            position=node.position,
            collapsed=False,
            node_kind=node.node_kind,
            updated_by="system",
            created_at=now,
            updated_at=now,
        )
        for index, node in enumerate(proposal.nodes)
    ]
    references: list[MindMapNodeReference] = []
    for proposal_node in proposal.nodes:
        if proposal_node.asset_block_id is None:
            continue
        node_id = node_ids[proposal_node.temp_id]
        references.append(MindMapNodeReference(
            id=make_mind_map_reference_id(), map_id=mind_map.id, node_id=node_id,
            ref_type="asset_block", ref_id=proposal_node.asset_block_id, relation="represents",
            fragment_selector=None, created_at=now,
        ))
        references.extend(
            MindMapNodeReference(
                id=make_mind_map_reference_id(), map_id=mind_map.id, node_id=node_id,
                ref_type="claim", ref_id=claim_id, relation="supports",
                fragment_selector=None, created_at=now,
            )
            for claim_id in proposal_node.claim_refs
        )
    session.add(mind_map)
    for node in nodes:
        session.add(node)
    for reference in references:
        session.add(reference)
    root_id = node_ids["root"]
    revision = await _record_revision(
        session, mind_map=mind_map, root_id=root_id, nodes=nodes, references=references,
        actor_type="system", actor_ref=None, action="map_created",
        summary="Projected Asset Blocks into an Outline Map", now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    for item in [*nodes, *references, revision]:
        await session.refresh(item)
    return MindMapTreeState(map=mind_map, root_id=root_id, nodes=nodes, references=references)


async def list_mind_maps(
    session: AsyncSession,
    *,
    user_id: str,
    owner_type: str | None = None,
    owner_id: str | None = None,
    purpose: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[MindMapSummaryState], int]:
    filters = [MindMap.user_id == user_id]
    if owner_type is not None:
        filters.append(MindMap.owner_type == owner_type)
    if owner_id is not None:
        filters.append(MindMap.owner_id == owner_id)
    if purpose is not None:
        filters.append(MindMap.purpose == purpose)

    rows = await session.execute(
        select(MindMap)
        .where(*filters)
        .order_by(MindMap.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    maps = list(rows.scalars().all())
    count_row = await session.execute(select(func.count(MindMap.id)).where(*filters))
    total = count_row.scalar_one()
    if not maps:
        return [], total

    root_rows = await session.execute(
        select(MindMapNode.map_id, MindMapNode.id).where(
            MindMapNode.map_id.in_([mind_map.id for mind_map in maps]),
            MindMapNode.parent_id.is_(None),
        )
    )
    root_by_map = dict(root_rows.all())
    summaries = []
    for mind_map in maps:
        root_id = root_by_map.get(mind_map.id)
        if root_id is None:
            raise _invalid_tree(mind_map.id, "Root node is missing")
        summaries.append(MindMapSummaryState(map=mind_map, root_id=root_id))
    return summaries, total


async def get_mind_map_summary(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> MindMapSummaryState:
    mind_map = await _get_map(session, user_id=user_id, map_id=map_id)
    root_rows = await session.execute(
        select(MindMapNode.id).where(
            MindMapNode.map_id == map_id,
            MindMapNode.parent_id.is_(None),
        )
    )
    root_ids = list(root_rows.scalars().all())
    if len(root_ids) != 1:
        raise _invalid_tree(map_id, f"Expected exactly one root node, found {len(root_ids)}")
    return MindMapSummaryState(map=mind_map, root_id=root_ids[0])


async def check_source_mind_map_staleness(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> MindMapStalenessState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    if mind_map.owner_type != "source" or mind_map.purpose != "document_overview":
        raise HTTPException(status_code=422, detail="Staleness checks require a Source document overview map")

    source_row = await session.execute(
        select(Source).where(Source.id == mind_map.owner_id, Source.user_id == user_id)
    )
    source = source_row.scalar_one_or_none()
    if source is None:
        raise HTTPException(status_code=404, detail="Source owner not found")
    chunk_count_row = await session.execute(
        select(func.count(SourceChunk.id)).where(SourceChunk.source_id == source.id)
    )
    chunk_count = int(chunk_count_row.scalar_one())
    root_rows = await session.execute(
        select(MindMapNode.id).where(
            MindMapNode.map_id == map_id,
            MindMapNode.parent_id.is_(None),
        )
    )
    root_ids = list(root_rows.scalars().all())
    if len(root_ids) != 1:
        raise _invalid_tree(map_id, f"Expected exactly one root node, found {len(root_ids)}")
    source_metadata = source.metadata_ if isinstance(source.metadata_, dict) else {}
    current_basis = {
        "source_content_hash": source.content_hash,
        "chunk_count": chunk_count,
        "chunk_revision": source_metadata.get("chunk_revision"),
    }
    recorded_basis = mind_map.basis_revision if isinstance(mind_map.basis_revision, dict) else {}
    reasons: list[str] = []
    if "source_content_hash" in recorded_basis and recorded_basis.get("source_content_hash") != current_basis["source_content_hash"]:
        reasons.append("source_content_hash")
    if "chunk_count" in recorded_basis and recorded_basis.get("chunk_count") != current_basis["chunk_count"]:
        reasons.append("chunk_count")
    recorded_chunk_revision = recorded_basis.get("chunk_revision", recorded_basis.get("source_chunk_revision"))
    if recorded_chunk_revision is not None and recorded_chunk_revision != current_basis["chunk_revision"]:
        reasons.append("chunk_revision")

    if reasons and mind_map.generation_status not in {"stale", "generating", "failed"}:
        mind_map.generation_status = "stale"
        mind_map.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(mind_map)
    return MindMapStalenessState(
        map=mind_map,
        root_id=root_ids[0],
        stale=bool(reasons) or mind_map.generation_status == "stale",
        reasons=tuple(reasons),
        current_basis=current_basis,
    )


async def check_asset_outline_staleness(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> MindMapStalenessState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    if mind_map.owner_type != "asset" or mind_map.purpose != "asset_outline":
        raise HTTPException(status_code=422, detail="Asset Outline staleness checks require an Asset Outline Map")
    asset_row = await session.execute(select(Asset).where(Asset.id == mind_map.owner_id, Asset.user_id == user_id))
    asset = asset_row.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset owner not found")
    current_basis = build_asset_outline_proposal(asset).basis_revision.model_dump()
    recorded_basis = mind_map.basis_revision if isinstance(mind_map.basis_revision, dict) else {}
    keys = ("workspace_revision", "intent_revision", "asset_document_revision", "base_document_signature")
    reasons = [key for key in keys if recorded_basis.get(key) != current_basis[key]]
    root_rows = await session.execute(
        select(MindMapNode.id).where(MindMapNode.map_id == map_id, MindMapNode.parent_id.is_(None))
    )
    root_ids = list(root_rows.scalars().all())
    if len(root_ids) != 1:
        raise _invalid_tree(map_id, f"Expected exactly one root node, found {len(root_ids)}")
    if reasons and mind_map.generation_status not in {"stale", "generating", "failed"}:
        mind_map.generation_status = "stale"
        mind_map.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(mind_map)
    return MindMapStalenessState(
        map=mind_map,
        root_id=root_ids[0],
        stale=bool(reasons) or mind_map.generation_status == "stale",
        reasons=tuple(reasons),
        current_basis=current_basis,
    )


async def build_asset_outline_refresh_proposal(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> AssetOutlineRefreshProposalRead:
    mind_map = await _get_map(session, user_id=user_id, map_id=map_id)
    if mind_map.owner_type != "asset" or mind_map.purpose != "asset_outline":
        raise HTTPException(status_code=422, detail="Refresh proposals require an Asset Outline Map")
    asset_row = await session.execute(select(Asset).where(Asset.id == mind_map.owner_id, Asset.user_id == user_id))
    asset = asset_row.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset owner not found")
    proposal = build_asset_outline_proposal(asset)
    return AssetOutlineRefreshProposalRead(
        map_id=mind_map.id,
        base_version=mind_map.version,
        proposal=proposal,
        node_count=len(proposal.nodes),
        reference_count=sum(1 + len(node.claim_refs) for node in proposal.nodes if node.asset_block_id is not None),
    )


async def apply_asset_outline_refresh_proposal(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    body: AssetOutlineRefreshApply,
) -> MindMapTreeState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    if mind_map.owner_type != "asset" or mind_map.purpose != "asset_outline":
        raise HTTPException(status_code=422, detail="Refresh proposals require an Asset Outline Map")
    if body.proposal.asset_id != mind_map.owner_id:
        raise HTTPException(status_code=422, detail="Refresh proposal does not belong to the target Asset Outline Map")

    asset_row = await session.execute(select(Asset).where(Asset.id == mind_map.owner_id, Asset.user_id == user_id))
    asset = asset_row.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset owner not found")
    current_proposal = build_asset_outline_proposal(asset)
    if body.proposal.model_dump() != current_proposal.model_dump():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "asset_outline_refresh_stale",
                "message": "The Asset changed after this Refresh Proposal was generated",
                "map_id": mind_map.id,
                "expected_basis": body.proposal.basis_revision.model_dump(),
                "current_basis": current_proposal.basis_revision.model_dump(),
            },
        )

    current_nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    _root_node(map_id, current_nodes)
    await session.execute(
        delete(MindMapNode)
        .where(MindMapNode.map_id == map_id)
        .execution_options(synchronize_session=False)
    )
    await session.flush()

    now = datetime.now(UTC)
    node_ids = {node.temp_id: make_mind_map_node_id() for node in current_proposal.nodes}
    nodes = [
        MindMapNode(
            id=node_ids[node.temp_id],
            map_id=mind_map.id,
            display_id=index + 1,
            parent_id=node_ids.get(node.parent_temp_id) if node.parent_temp_id else None,
            content=node.content,
            note=None,
            position=node.position,
            collapsed=False,
            node_kind=node.node_kind,
            updated_by="system",
            created_at=now,
            updated_at=now,
        )
        for index, node in enumerate(current_proposal.nodes)
    ]
    references: list[MindMapNodeReference] = []
    for proposal_node in current_proposal.nodes:
        if proposal_node.asset_block_id is None:
            continue
        node_id = node_ids[proposal_node.temp_id]
        references.append(MindMapNodeReference(
            id=make_mind_map_reference_id(), map_id=mind_map.id, node_id=node_id,
            ref_type="asset_block", ref_id=proposal_node.asset_block_id, relation="represents",
            fragment_selector=None, created_at=now,
        ))
        references.extend(
            MindMapNodeReference(
                id=make_mind_map_reference_id(), map_id=mind_map.id, node_id=node_id,
                ref_type="claim", ref_id=claim_id, relation="supports",
                fragment_selector=None, created_at=now,
            )
            for claim_id in proposal_node.claim_refs
        )
    for item in [*nodes, *references]:
        session.add(item)
    await session.flush()

    previous_version = mind_map.version
    mind_map.title = current_proposal.title
    mind_map.layout_mode = current_proposal.layout_mode
    mind_map.basis_revision = current_proposal.basis_revision.model_dump()
    mind_map.generation_status = "ready"
    mind_map.version = previous_version + 1
    mind_map.updated_at = now
    root_id = node_ids["root"]
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root_id,
        nodes=nodes,
        references=references,
        actor_type="human",
        actor_ref=None,
        action="asset_outline_refreshed",
        summary=f"Applied confirmed Asset Outline Refresh Proposal to version {previous_version}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapTreeState(map=mind_map, root_id=root_id, nodes=nodes, references=references)


async def validate_source_mind_map_proposal(
    session: AsyncSession,
    *,
    user_id: str,
    body: SourceMindMapProposalValidate,
) -> SourceMindMapProposalValidationState:
    source_row = await session.execute(
        select(Source).where(Source.id == body.source_id, Source.user_id == user_id)
    )
    source = source_row.scalar_one_or_none()
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    if source.source_type != "pdf":
        raise HTTPException(status_code=422, detail="Source Mind Map proposals require a PDF Source")

    chunk_count_row = await session.execute(
        select(func.count(SourceChunk.id)).where(SourceChunk.source_id == source.id)
    )
    chunk_count = int(chunk_count_row.scalar_one())
    if chunk_count == 0:
        raise HTTPException(status_code=422, detail="PDF extraction must produce Source Chunks before proposal validation")
    source_metadata = source.metadata_ if isinstance(source.metadata_, dict) else {}
    current_basis = {
        "source_content_hash": source.content_hash,
        "chunk_count": chunk_count,
        "chunk_revision": source_metadata.get("chunk_revision"),
    }
    requested_basis = body.basis_revision.model_dump()
    mismatches = [
        key
        for key in ("source_content_hash", "chunk_count", "chunk_revision")
        if requested_basis[key] != current_basis[key]
    ]
    if mismatches:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "source_mind_map_basis_conflict",
                "message": "Source content changed after the Mind Map proposal was generated",
                "source_id": source.id,
                "mismatches": mismatches,
                "expected_basis": requested_basis,
                "current_basis": current_basis,
            },
        )

    chunk_ids = sorted({reference.chunk_id for reference in body.proposal.references})
    chunk_by_id: dict[int, str] = {}
    if chunk_ids:
        chunk_rows = await session.execute(
            select(SourceChunk.id, SourceChunk.content).where(
                SourceChunk.source_id == source.id,
                SourceChunk.id.in_(chunk_ids),
            )
        )
        chunk_by_id = {int(chunk_id): content for chunk_id, content in chunk_rows.all()}
        missing_chunk_ids = [chunk_id for chunk_id in chunk_ids if chunk_id not in chunk_by_id]
        if missing_chunk_ids:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "source_mind_map_invalid_chunk_references",
                    "message": "Proposal references Source Chunks outside the selected PDF",
                    "source_id": source.id,
                    "chunk_ids": missing_chunk_ids,
                },
            )

    invalid_quotes: list[dict[str, int | str]] = []
    for reference in body.proposal.references:
        quote = reference.fragment_selector.quote if reference.fragment_selector else None
        if quote is not None and quote not in chunk_by_id[reference.chunk_id]:
            invalid_quotes.append(
                {"node_temp_id": reference.node_temp_id, "chunk_id": reference.chunk_id}
            )
    if invalid_quotes:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "source_mind_map_invalid_fragment_quotes",
                "message": "Proposal fragment quotes must occur in their referenced Source Chunks",
                "references": invalid_quotes,
            },
        )

    if body.target_node_id is not None:
        assert body.map_id is not None and body.base_version is not None
        mind_map = await _get_map(session, user_id=user_id, map_id=body.map_id)
        _validate_version(mind_map, body.base_version)
        if mind_map.owner_type != "source" or mind_map.owner_id != body.source_id or mind_map.purpose != "document_overview":
            raise HTTPException(status_code=422, detail="Branch proposal does not belong to the target Source Mind Map")
        target_row = await session.execute(
            select(MindMapNode).where(
                MindMapNode.id == body.target_node_id,
                MindMapNode.map_id == mind_map.id,
            )
        )
        target_node = target_row.scalar_one_or_none()
        if target_node is None:
            raise HTTPException(status_code=404, detail="Branch expansion target node not found")
        root_proposal = next(node for node in body.proposal.nodes if node.parent_temp_id is None)
        if root_proposal.content != target_node.content:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "source_mind_map_branch_anchor_mismatch",
                    "message": "Branch proposal root must exactly match the selected target node",
                    "target_node_id": target_node.id,
                },
            )
        if any(reference.node_temp_id == root_proposal.temp_id for reference in body.proposal.references):
            raise HTTPException(
                status_code=422,
                detail="Branch proposal cannot add references to the existing target node",
            )

    return SourceMindMapProposalValidationState(
        source_id=source.id,
        basis_revision=current_basis,
        proposal=body.proposal,
        node_count=len(body.proposal.nodes),
        reference_count=len(body.proposal.references),
    )


def _proposal_nodes_in_tree_order(proposal: SourceMindMapProposal):
    children_by_parent: dict[str | None, list] = {}
    for node in proposal.nodes:
        children_by_parent.setdefault(node.parent_temp_id, []).append(node)
    for children in children_by_parent.values():
        children.sort(key=lambda item: item.position)

    ordered = []

    def visit(parent_temp_id: str | None) -> None:
        for node in children_by_parent.get(parent_temp_id, []):
            ordered.append(node)
            visit(node.temp_id)

    visit(None)
    return ordered


def _default_collapsed_proposal_ids(proposal_nodes: list) -> set[str]:
    if len(proposal_nodes) <= SOURCE_MIND_MAP_AUTO_COLLAPSE_THRESHOLD:
        return set()
    depth_by_temp_id: dict[str, int] = {}
    parent_temp_ids = {
        node.parent_temp_id
        for node in proposal_nodes
        if node.parent_temp_id is not None
    }
    collapsed_ids: set[str] = set()
    for node in proposal_nodes:
        depth = 0 if node.parent_temp_id is None else depth_by_temp_id[node.parent_temp_id] + 1
        depth_by_temp_id[node.temp_id] = depth
        if depth == SOURCE_MIND_MAP_AUTO_COLLAPSE_DEPTH and node.temp_id in parent_temp_ids:
            collapsed_ids.add(node.temp_id)
    return collapsed_ids


def _proposal_reference(
    *,
    map_id: str,
    node_id: str,
    proposal_reference,
    now: datetime,
) -> MindMapNodeReference:
    return MindMapNodeReference(
        id=make_mind_map_reference_id(),
        map_id=map_id,
        node_id=node_id,
        ref_type="source_chunk",
        ref_id=str(proposal_reference.chunk_id),
        relation=proposal_reference.relation,
        fragment_selector=(
            proposal_reference.fragment_selector.model_dump(exclude_none=True)
            if proposal_reference.fragment_selector is not None
            else None
        ),
        created_at=now,
    )


async def apply_source_mind_map_proposal(
    session: AsyncSession,
    *,
    user_id: str,
    body: SourceMindMapProposalApply,
) -> MindMapTreeState:
    await validate_source_mind_map_proposal(session, user_id=user_id, body=body)
    now = datetime.now(UTC)
    proposal_nodes = _proposal_nodes_in_tree_order(body.proposal)
    default_collapsed_ids = _default_collapsed_proposal_ids(proposal_nodes)
    root_proposal = proposal_nodes[0]

    if body.map_id is None:
        existing_row = await session.execute(
            select(MindMap.id).where(
                MindMap.user_id == user_id,
                MindMap.owner_type == "source",
                MindMap.owner_id == body.source_id,
                MindMap.purpose == "document_overview",
            )
        )
        existing_map_id = existing_row.scalar_one_or_none()
        if existing_map_id is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "source_mind_map_already_exists",
                    "message": "A Source Mind Map was created before this proposal was applied",
                    "map_id": existing_map_id,
                },
            )

        mind_map = MindMap(
            id=make_mind_map_id(),
            user_id=user_id,
            title=body.proposal.title,
            owner_type="source",
            owner_id=body.source_id,
            purpose="document_overview",
            layout_mode=body.proposal.layout_mode,
            version=1,
            basis_revision=body.basis_revision.model_dump(),
            generation_status="ready",
            created_at=now,
            updated_at=now,
        )
        session.add(mind_map)
        nodes: list[MindMapNode] = []
        node_by_temp_id: dict[str, MindMapNode] = {}
        for display_id, proposal_node in enumerate(proposal_nodes, start=1):
            parent = node_by_temp_id.get(proposal_node.parent_temp_id)
            node = MindMapNode(
                id=make_mind_map_node_id(),
                map_id=mind_map.id,
                display_id=display_id,
                parent_id=parent.id if parent is not None else None,
                content=proposal_node.content,
                note=proposal_node.note,
                position=proposal_node.position,
                collapsed=proposal_node.temp_id in default_collapsed_ids,
                node_kind=proposal_node.node_kind,
                updated_by="agent",
                created_at=now,
                updated_at=now,
            )
            session.add(node)
            nodes.append(node)
            node_by_temp_id[proposal_node.temp_id] = node
        await session.flush()
        references = [
            _proposal_reference(
                map_id=mind_map.id,
                node_id=node_by_temp_id[reference.node_temp_id].id,
                proposal_reference=reference,
                now=now,
            )
            for reference in body.proposal.references
        ]
        for reference in references:
            session.add(reference)
        await session.flush()
        revision = await _record_revision(
            session,
            mind_map=mind_map,
            root_id=node_by_temp_id[root_proposal.temp_id].id,
            nodes=nodes,
            references=references,
            actor_type="agent",
            actor_ref=body.session_id,
            action="map_created",
            summary=f"Created Source Mind Map from confirmed Agent proposal with {len(nodes)} nodes",
            now=now,
        )
        await session.commit()
        await session.refresh(mind_map)
        await session.refresh(revision)
        return MindMapTreeState(
            map=mind_map,
            root_id=node_by_temp_id[root_proposal.temp_id].id,
            nodes=nodes,
            references=references,
        )

    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=body.map_id)
    _validate_version(mind_map, body.base_version)
    if mind_map.owner_type != "source" or mind_map.owner_id != body.source_id or mind_map.purpose != "document_overview":
        raise HTTPException(status_code=422, detail="Proposal does not belong to the target Source Mind Map")

    nodes = await _load_nodes(session, map_id=mind_map.id, for_update=True)
    references = await _load_references(session, map_id=mind_map.id)
    root = _root_node(mind_map.id, nodes)
    branch_target = next(
        (node for node in nodes if node.id == body.target_node_id),
        None,
    ) if body.target_node_id is not None else None
    if body.target_node_id is not None and branch_target is None:
        raise HTTPException(status_code=404, detail="Branch expansion target node not found")
    proposal_anchor = branch_target or root
    node_by_temp_id = {root_proposal.temp_id: proposal_anchor}
    if branch_target is None:
        root.content = root_proposal.content
        root.note = root_proposal.note
        root.node_kind = root_proposal.node_kind
        root.updated_by = "agent"
        root.updated_at = now

    next_display_id = max(node.display_id for node in nodes) + 1
    used_existing_ids = {proposal_anchor.id}
    for proposal_node in proposal_nodes[1:]:
        parent = node_by_temp_id[proposal_node.parent_temp_id]
        match = next(
            (
                node
                for node in nodes
                if node.id not in used_existing_ids
                and node.parent_id == parent.id
                and node.content == proposal_node.content
                and node.node_kind == proposal_node.node_kind
            ),
            None,
        )
        if match is None:
            sibling_positions = [node.position for node in nodes if node.parent_id == parent.id]
            match = MindMapNode(
                id=make_mind_map_node_id(),
                map_id=mind_map.id,
                display_id=next_display_id,
                parent_id=parent.id,
                content=proposal_node.content,
                note=proposal_node.note,
                position=max(sibling_positions, default=-1) + 1,
                collapsed=proposal_node.temp_id in default_collapsed_ids,
                node_kind=proposal_node.node_kind,
                updated_by="agent",
                created_at=now,
                updated_at=now,
            )
            next_display_id += 1
            session.add(match)
            nodes.append(match)
        used_existing_ids.add(match.id)
        node_by_temp_id[proposal_node.temp_id] = match

    reference_keys = {
        (reference.node_id, reference.ref_id, reference.relation)
        for reference in references
        if reference.ref_type == "source_chunk"
    }
    for proposal_reference in body.proposal.references:
        node = node_by_temp_id[proposal_reference.node_temp_id]
        key = (node.id, str(proposal_reference.chunk_id), proposal_reference.relation)
        if key in reference_keys:
            continue
        reference = _proposal_reference(
            map_id=mind_map.id,
            node_id=node.id,
            proposal_reference=proposal_reference,
            now=now,
        )
        session.add(reference)
        references.append(reference)
        reference_keys.add(key)

    previous_version = mind_map.version
    if branch_target is None:
        mind_map.title = body.proposal.title
        mind_map.layout_mode = body.proposal.layout_mode
    mind_map.basis_revision = body.basis_revision.model_dump()
    mind_map.generation_status = "ready"
    mind_map.version += 1
    mind_map.updated_at = now
    await session.flush()
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type="agent",
        actor_ref=body.session_id,
        action="outline_applied",
        summary=(
            f"Expanded Source Mind Map branch {branch_target.display_id} from confirmed Agent proposal; "
            "existing nodes were preserved"
            if branch_target is not None
            else f"Merged confirmed Agent proposal into Source Mind Map version {previous_version}; existing nodes were preserved"
        ),
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapTreeState(map=mind_map, root_id=root.id, nodes=nodes, references=references)


async def update_mind_map(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    body: MindMapUpdate,
    actor_type: str = "human",
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    data = body.model_dump(exclude_unset=True, exclude={"base_version"})
    for key, value in data.items():
        setattr(mind_map, key, value)
    previous_version = mind_map.version
    now = datetime.now(UTC)
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=actor_type,
        actor_ref=actor_ref,
        action="map_updated",
        summary="Updated Mind Map settings",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
    )


async def delete_mind_map(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    body: MindMapDelete,
) -> None:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    await session.delete(mind_map)
    await session.commit()


async def get_mind_map_tree(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
) -> MindMapTreeState:
    mind_map = await _get_map(session, user_id=user_id, map_id=map_id)
    nodes = await _load_nodes(session, map_id=map_id)
    root = _root_node(map_id, nodes)
    references = await _load_references(session, map_id=map_id)
    return MindMapTreeState(
        map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
    )


async def add_mind_map_node(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    body: MindMapNodeCreate,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    _node_by_id(map_id, nodes, body.parent_id)

    now = datetime.now(UTC)
    node = MindMapNode(
        id=make_mind_map_node_id(),
        map_id=map_id,
        display_id=max((item.display_id for item in nodes), default=0) + 1,
        parent_id=body.parent_id,
        content=body.content,
        note=body.note,
        position=0,
        collapsed=False,
        node_kind=body.node_kind,
        updated_by=body.updated_by,
        created_at=now,
        updated_at=now,
    )
    _insert_at_position(
        nodes,
        node,
        parent_id=body.parent_id,
        position=body.position,
        now=now,
    )
    nodes.append(node)
    session.add(node)
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="node_added",
        summary=f"Added node {node.display_id}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(node)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        node=node,
    )


async def update_mind_map_node(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    node_id: str,
    body: MindMapNodeUpdate,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    node = _node_by_id(map_id, nodes, node_id)
    data = body.model_dump(exclude_unset=True, exclude={"base_version", "updated_by"})
    for key, value in data.items():
        setattr(node, key, value)
    now = datetime.now(UTC)
    node.updated_by = body.updated_by
    node.updated_at = now
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="node_updated",
        summary=f"Updated node {node.display_id}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(node)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        node=node,
    )


async def move_mind_map_node(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    node_id: str,
    body: MindMapNodeMove,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    node = _node_by_id(map_id, nodes, node_id)
    _node_by_id(map_id, nodes, body.parent_id)
    if node.id == root.id:
        raise HTTPException(status_code=409, detail="Root node cannot be moved")
    if body.parent_id in _subtree_ids(nodes, node.id):
        raise HTTPException(status_code=409, detail="Node cannot be moved into its own subtree")

    now = datetime.now(UTC)
    _insert_at_position(
        nodes,
        node,
        parent_id=body.parent_id,
        position=body.position,
        now=now,
    )
    node.updated_by = body.updated_by
    node.updated_at = now
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="node_moved",
        summary=f"Moved node {node.display_id}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(node)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        node=node,
    )


async def delete_mind_map_node(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    node_id: str,
    body: MindMapNodeDelete,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    node = _node_by_id(map_id, nodes, node_id)
    if node.id == root.id:
        raise HTTPException(status_code=409, detail="Root node cannot be deleted; delete the Map")

    deleted_ids = _subtree_ids(nodes, node.id)
    remaining_nodes = [item for item in nodes if item.id not in deleted_ids]
    now = datetime.now(UTC)
    _set_sibling_positions(
        _ordered_siblings(remaining_nodes, node.parent_id),
        now,
    )
    await session.execute(
        delete(MindMapNode)
        .where(MindMapNode.map_id == map_id, MindMapNode.id.in_(deleted_ids))
        .execution_options(synchronize_session=False)
    )
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = [
        reference
        for reference in await _load_references(session, map_id=map_id)
        if reference.node_id not in deleted_ids
    ]
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=remaining_nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="node_deleted",
        summary=f"Deleted node {node.display_id} and {len(deleted_ids) - 1} descendants",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        deleted_node_ids=tuple(sorted(deleted_ids)),
    )


def _validate_outline_root(
    root: MindMapNode,
    parsed: list[ParsedMindMapOutlineNode],
) -> None:
    outline_root_id = parsed[0].display_id
    if outline_root_id is not None and outline_root_id != root.display_id:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Outline root ID {outline_root_id} does not match "
                f"Mind Map root ID {root.display_id}"
            ),
        )


async def _merge_mind_map_outline(
    session: AsyncSession,
    *,
    nodes: list[MindMapNode],
    root: MindMapNode,
    parsed: list[ParsedMindMapOutlineNode],
    updated_by: str,
    now: datetime,
) -> tuple[list[MindMapNode], int, int, int]:
    _validate_outline_root(root, parsed)
    existing_by_display_id = {node.display_id: node for node in nodes}
    original_state = {
        node.id: (node.parent_id, node.position, node.content)
        for node in nodes
    }
    parsed_nodes: dict[int, MindMapNode] = {0: root}
    specified_children: dict[str, list[MindMapNode]] = {}
    affected_parent_ids: set[str] = set()
    next_display_id = max(existing_by_display_id) + 1
    created_count = 0
    updated_count = 0

    if root.content != parsed[0].content:
        root.content = parsed[0].content
        root.updated_by = updated_by
        root.updated_at = now
        updated_count += 1

    for index, item in enumerate(parsed[1:], start=1):
        parent = parsed_nodes[item.parent_index]
        if item.display_id is None:
            node = MindMapNode(
                id=make_mind_map_node_id(),
                map_id=root.map_id,
                display_id=next_display_id,
                parent_id=parent.id,
                content=item.content,
                note=None,
                position=0,
                collapsed=False,
                node_kind="topic",
                updated_by=updated_by,
                created_at=now,
                updated_at=now,
            )
            next_display_id += 1
            session.add(node)
            await session.flush()
            nodes.append(node)
            created_count += 1
        else:
            node = existing_by_display_id.get(item.display_id)
            if node is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"Outline references unknown display ID {item.display_id}",
                )
            if node.id == root.id:
                raise HTTPException(
                    status_code=422,
                    detail="Mind Map root can only appear as the Outline root",
                )
            if node.content != item.content:
                node.content = item.content
                node.updated_by = updated_by
                node.updated_at = now
                updated_count += 1
            if node.parent_id is not None:
                affected_parent_ids.add(node.parent_id)
            if node.parent_id != parent.id:
                node.updated_by = updated_by
                node.updated_at = now
            node.parent_id = parent.id
        parsed_nodes[index] = node
        specified_children.setdefault(parent.id, []).append(node)
        affected_parent_ids.add(parent.id)

    for parent_id in affected_parent_ids:
        specified = specified_children.get(parent_id, [])
        specified_ids = {node.id for node in specified}
        remaining = sorted(
            (
                node
                for node in nodes
                if node.parent_id == parent_id and node.id not in specified_ids
            ),
            key=lambda node: (
                original_state.get(node.id, (None, node.position, ""))[1],
                node.display_id,
            ),
        )
        _set_sibling_positions([*specified, *remaining], now)

    _root_node(root.map_id, nodes)
    await session.flush()
    moved_count = sum(
        1
        for node in nodes
        if node.id in original_state
        and (node.parent_id, node.position) != original_state[node.id][:2]
    )
    return nodes, created_count, updated_count, moved_count


async def _replace_mind_map_outline(
    session: AsyncSession,
    *,
    nodes: list[MindMapNode],
    root: MindMapNode,
    parsed: list[ParsedMindMapOutlineNode],
    updated_by: str,
    now: datetime,
) -> tuple[list[MindMapNode], int, int, tuple[str, ...]]:
    _validate_outline_root(root, parsed)
    old_nodes = [node for node in nodes if node.id != root.id]
    deleted_node_ids = tuple(sorted(node.id for node in old_nodes))
    updated_count = 0
    if root.content != parsed[0].content:
        root.content = parsed[0].content
        root.updated_by = updated_by
        root.updated_at = now
        updated_count = 1

    explicit_ids = {
        item.display_id
        for item in parsed[1:]
        if item.display_id is not None
    }
    if root.display_id in explicit_ids:
        raise HTTPException(
            status_code=422,
            detail="Mind Map root can only appear as the Outline root",
        )

    await session.execute(
        delete(MindMapNode)
        .where(MindMapNode.map_id == root.map_id, MindMapNode.id != root.id)
        .execution_options(synchronize_session=False)
    )
    await session.flush()

    used_display_ids = {root.display_id, *explicit_ids}
    next_display_id = max(
        [node.display_id for node in nodes] + list(used_display_ids)
    ) + 1
    parsed_nodes: dict[int, MindMapNode] = {0: root}
    sibling_counts: dict[str, int] = {}
    replacement_nodes = [root]
    for index, item in enumerate(parsed[1:], start=1):
        parent = parsed_nodes[item.parent_index]
        display_id = item.display_id
        if display_id is None:
            while next_display_id in used_display_ids:
                next_display_id += 1
            display_id = next_display_id
            used_display_ids.add(display_id)
            next_display_id += 1
        position = sibling_counts.get(parent.id, 0)
        sibling_counts[parent.id] = position + 1
        node = MindMapNode(
            id=make_mind_map_node_id(),
            map_id=root.map_id,
            display_id=display_id,
            parent_id=parent.id,
            content=item.content,
            note=None,
            position=position,
            collapsed=False,
            node_kind="topic",
            updated_by=updated_by,
            created_at=now,
            updated_at=now,
        )
        session.add(node)
        await session.flush()
        parsed_nodes[index] = node
        replacement_nodes.append(node)

    _root_node(root.map_id, replacement_nodes)
    return replacement_nodes, len(replacement_nodes) - 1, updated_count, deleted_node_ids


async def apply_mind_map_outline(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    body: MindMapOutlineApply,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    parsed = parse_mind_map_outline(body.outline)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    now = datetime.now(UTC)
    deleted_node_ids: tuple[str, ...] = ()
    deleted_count = 0
    moved_count = 0
    if body.mode == "merge":
        nodes, created_count, updated_count, moved_count = await _merge_mind_map_outline(
            session,
            nodes=nodes,
            root=root,
            parsed=parsed,
            updated_by=body.updated_by,
            now=now,
        )
    else:
        nodes, created_count, updated_count, deleted_node_ids = await _replace_mind_map_outline(
            session,
            nodes=nodes,
            root=root,
            parsed=parsed,
            updated_by=body.updated_by,
            now=now,
        )
        deleted_count = len(deleted_node_ids)

    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="outline_applied",
        summary=(
            f"Applied {body.mode} Outline: {created_count} created, "
            f"{updated_count} updated, {moved_count} moved, {deleted_count} deleted"
        ),
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        deleted_node_ids=deleted_node_ids,
        outline_mode=body.mode,
        created_count=created_count,
        updated_count=updated_count,
        moved_count=moved_count,
        deleted_count=deleted_count,
    )


async def create_mind_map_reference(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    node_id: str,
    body: MindMapReferenceCreate,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    _node_by_id(map_id, nodes, node_id)
    await _validate_reference_target(
        session,
        user_id=user_id,
        mind_map=mind_map,
        ref_type=body.ref_type,
        ref_id=body.ref_id,
    )
    await _ensure_reference_unique(
        session,
        node_id=node_id,
        ref_type=body.ref_type,
        ref_id=body.ref_id,
        relation=body.relation,
    )

    now = datetime.now(UTC)
    reference = MindMapNodeReference(
        id=make_mind_map_reference_id(),
        map_id=map_id,
        node_id=node_id,
        ref_type=body.ref_type,
        ref_id=body.ref_id,
        relation=body.relation,
        fragment_selector=deepcopy(body.fragment_selector),
        created_at=now,
    )
    session.add(reference)
    await session.flush()
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="reference_added",
        summary=f"Added {body.ref_type} reference to node {node_id}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(reference)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        reference=reference,
    )


async def update_mind_map_reference(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    node_id: str,
    reference_id: str,
    body: MindMapReferenceUpdate,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    _node_by_id(map_id, nodes, node_id)
    reference = await _get_reference_for_update(
        session,
        map_id=map_id,
        node_id=node_id,
        reference_id=reference_id,
    )
    next_relation = body.relation or reference.relation
    if next_relation != reference.relation:
        await _ensure_reference_unique(
            session,
            node_id=node_id,
            ref_type=reference.ref_type,
            ref_id=reference.ref_id,
            relation=next_relation,
            exclude_id=reference.id,
        )

    now = datetime.now(UTC)
    reference.relation = next_relation
    if "fragment_selector" in body.model_fields_set:
        reference.fragment_selector = deepcopy(body.fragment_selector)
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="reference_updated",
        summary=f"Updated reference {reference.id}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(reference)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        reference=reference,
    )


async def delete_mind_map_reference(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    node_id: str,
    reference_id: str,
    body: MindMapReferenceDelete,
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    root = _root_node(map_id, nodes)
    _node_by_id(map_id, nodes, node_id)
    reference = await _get_reference_for_update(
        session,
        map_id=map_id,
        node_id=node_id,
        reference_id=reference_id,
    )

    now = datetime.now(UTC)
    await session.delete(reference)
    await session.flush()
    previous_version = mind_map.version
    mind_map.version += 1
    mind_map.updated_at = now
    references = await _load_references(session, map_id=map_id)
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=root.id,
        nodes=nodes,
        references=references,
        actor_type=body.updated_by,
        actor_ref=actor_ref,
        action="reference_deleted",
        summary=f"Deleted reference {reference.id}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=root.id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        reference=reference,
    )


async def list_mind_map_references_by_target(
    session: AsyncSession,
    *,
    user_id: str,
    ref_type: str,
    ref_id: str,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[MindMapNodeReference], int]:
    filters = (
        MindMap.user_id == user_id,
        MindMapNodeReference.ref_type == ref_type,
        MindMapNodeReference.ref_id == ref_id,
    )
    rows = await session.execute(
        select(MindMapNodeReference)
        .join(MindMap, MindMap.id == MindMapNodeReference.map_id)
        .where(*filters)
        .order_by(MindMapNodeReference.created_at.desc(), MindMapNodeReference.id)
        .limit(limit)
        .offset(offset)
    )
    total_row = await session.execute(
        select(func.count())
        .select_from(MindMapNodeReference)
        .join(MindMap, MindMap.id == MindMapNodeReference.map_id)
        .where(*filters)
    )
    return list(rows.scalars().all()), total_row.scalar_one()


async def list_mind_map_revisions(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[MindMapRevision], int]:
    await _get_map(session, user_id=user_id, map_id=map_id)
    rows = await session.execute(
        select(MindMapRevision)
        .where(MindMapRevision.map_id == map_id)
        .order_by(MindMapRevision.version.desc())
        .limit(limit)
        .offset(offset)
    )
    count_row = await session.execute(
        select(func.count(MindMapRevision.id)).where(MindMapRevision.map_id == map_id)
    )
    return list(rows.scalars().all()), count_row.scalar_one()


async def get_mind_map_revision(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    version: int,
) -> MindMapRevision:
    await _get_map(session, user_id=user_id, map_id=map_id)
    row = await session.execute(
        select(MindMapRevision).where(
            MindMapRevision.map_id == map_id,
            MindMapRevision.version == version,
        )
    )
    revision = row.scalar_one_or_none()
    if revision is None:
        raise HTTPException(status_code=404, detail="Mind Map revision not found")
    return revision


def _validated_restore_snapshot(
    mind_map: MindMap,
    revision: MindMapRevision,
) -> tuple[MindMapSnapshotRead, MindMapTreeRead]:
    try:
        snapshot = MindMapSnapshotRead.model_validate(revision.snapshot)
        tree = MindMapTreeRead(
            map=snapshot.map,
            root_id=snapshot.map.root_node_id,
            nodes=snapshot.nodes,
            references=snapshot.references,
        )
    except ValidationError as exc:
        raise _invalid_tree(mind_map.id, "Revision snapshot is not a valid Mind Map tree") from exc

    snapshot_map = snapshot.map
    identity_fields = ("id", "user_id", "owner_type", "owner_id", "purpose")
    mismatches = [
        field
        for field in identity_fields
        if getattr(snapshot_map, field) != getattr(mind_map, field)
    ]
    if mismatches:
        raise _invalid_tree(
            mind_map.id,
            f"Revision snapshot changes immutable Map identity: {', '.join(mismatches)}",
        )
    if snapshot_map.version != revision.version:
        raise _invalid_tree(mind_map.id, "Revision snapshot version does not match Revision")
    return snapshot, tree


async def _restore_nodes(
    session: AsyncSession,
    *,
    map_id: str,
    snapshot: MindMapSnapshotRead,
) -> list[MindMapNode]:
    pending = {node.id: node for node in snapshot.nodes}
    restored: list[MindMapNode] = []
    restored_ids: set[str] = set()
    while pending:
        ready = [
            node
            for node in pending.values()
            if node.parent_id is None or node.parent_id in restored_ids
        ]
        if not ready:
            raise _invalid_tree(map_id, "Revision snapshot nodes cannot be restored in parent order")
        ready.sort(key=lambda node: (node.parent_id or "", node.position, node.display_id))
        for node in ready:
            restored_node = MindMapNode(
                id=node.id,
                map_id=map_id,
                display_id=node.display_id,
                parent_id=node.parent_id,
                content=node.content,
                note=node.note,
                position=node.position,
                collapsed=node.collapsed,
                node_kind=node.node_kind,
                updated_by=node.updated_by,
                created_at=node.created_at,
                updated_at=node.updated_at,
            )
            session.add(restored_node)
            restored.append(restored_node)
            restored_ids.add(node.id)
            pending.pop(node.id)
        await session.flush()
    return restored


async def restore_mind_map_revision(
    session: AsyncSession,
    *,
    user_id: str,
    map_id: str,
    version: int,
    body: MindMapRevisionRestore,
    actor_type: str = "human",
    actor_ref: str | None = None,
) -> MindMapMutationState:
    mind_map = await _get_map_for_update(session, user_id=user_id, map_id=map_id)
    _validate_version(mind_map, body.base_version)
    target_row = await session.execute(
        select(MindMapRevision).where(
            MindMapRevision.map_id == map_id,
            MindMapRevision.version == version,
        )
    )
    target_revision = target_row.scalar_one_or_none()
    if target_revision is None:
        raise HTTPException(status_code=404, detail="Mind Map revision not found")
    if target_revision.version >= mind_map.version:
        raise HTTPException(status_code=409, detail="Only a historical Mind Map revision can be restored")

    snapshot, tree = _validated_restore_snapshot(mind_map, target_revision)
    current_nodes = await _load_nodes(session, map_id=map_id, for_update=True)
    await session.execute(
        delete(MindMapNode)
        .where(MindMapNode.map_id == map_id)
        .execution_options(synchronize_session=False)
    )
    await session.flush()

    restored_nodes = await _restore_nodes(session, map_id=map_id, snapshot=snapshot)
    restored_references = []
    for reference in snapshot.references:
        restored_reference = MindMapNodeReference(
            id=reference.id,
            map_id=map_id,
            node_id=reference.node_id,
            ref_type=reference.ref_type,
            ref_id=reference.ref_id,
            relation=reference.relation,
            fragment_selector=deepcopy(reference.fragment_selector),
            created_at=reference.created_at,
        )
        session.add(restored_reference)
        restored_references.append(restored_reference)
    await session.flush()

    previous_version = mind_map.version
    now = datetime.now(UTC)
    mind_map.title = snapshot.map.title
    mind_map.layout_mode = snapshot.map.layout_mode
    mind_map.basis_revision = deepcopy(snapshot.map.basis_revision)
    mind_map.generation_status = snapshot.map.generation_status
    mind_map.version = previous_version + 1
    mind_map.updated_at = now
    revision = await _record_revision(
        session,
        mind_map=mind_map,
        root_id=tree.root_id,
        nodes=restored_nodes,
        references=restored_references,
        actor_type=actor_type,
        actor_ref=actor_ref,
        action="restored",
        summary=f"Restored Mind Map from version {target_revision.version}",
        now=now,
    )
    await session.commit()
    await session.refresh(mind_map)
    await session.refresh(revision)
    return MindMapMutationState(
        map=mind_map,
        root_id=tree.root_id,
        previous_version=previous_version,
        current_version=mind_map.version,
        revision=revision,
        deleted_node_ids=tuple(sorted(node.id for node in current_nodes)),
    )
