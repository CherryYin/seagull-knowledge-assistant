from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.memory import MemoryEmbedding, MemoryNode
from pkg.models.user import User
from pkg.schemas.memory import (
    MemoryEdgeList,
    MemoryGraphRead,
    MemoryNodeList,
    MemoryNodeRead,
    MemoryNodeUpdate,
    TopicMemoryCandidate,
    TopicMemoryCandidateList,
    TopicMemoryCompileRequest,
    MemoryNodeMergeRequest,
)
from pkg.services.memory_edges import load_memory_edges, sync_memory_edges_for_node
from pkg.services.memory_tree import compile_topic_memory_node, preview_topic_memory_candidates

router = APIRouter()


@router.get("", response_model=MemoryNodeList)
async def list_memory_nodes(
    node_type: str | None = None,
    level: str | None = None,
    scope_id: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, pattern=r"^(active|archived|pending_review|rejected|merged)$"),
    has_embedding: bool | None = None,
    stale: bool | None = None,
    source: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    filters = [MemoryNode.user_id == user.id]

    if node_type:
        filters.append(MemoryNode.node_type == node_type)
    if level:
        filters.append(MemoryNode.level == level)
    if scope_id:
        filters.append(MemoryNode.scope_id == scope_id)
    if q:
        needle = f"%{q.strip()}%"
        filters.append(or_(MemoryNode.title.ilike(needle), MemoryNode.summary.ilike(needle), MemoryNode.content.ilike(needle)))
    if status:
        if status == "archived":
            filters.append(MemoryNode.metadata_["status"].astext == "archived")
        elif status in {"pending_review", "rejected", "merged"}:
            filters.append(MemoryNode.metadata_["status"].astext == status)
        else:
            filters.append(or_(
                MemoryNode.metadata_.is_(None),
                ~MemoryNode.metadata_.has_key("status"),  # noqa: W601 - SQLAlchemy JSONB has_key operator
                MemoryNode.metadata_["status"].astext == "active",
            ))
    if has_embedding is not None:
        embedding_exists = exists().where(MemoryEmbedding.memory_node_id == MemoryNode.id)
        filters.append(embedding_exists if has_embedding else ~embedding_exists)
    if stale is not None:
        stale_filter = MemoryNode.metadata_["stale"].astext == "true"
        filters.append(stale_filter if stale else or_(
            MemoryNode.metadata_.is_(None),
            ~MemoryNode.metadata_.has_key("stale"),  # noqa: W601 - SQLAlchemy JSONB has_key operator
            MemoryNode.metadata_["stale"].astext != "true",
        ))
    if source:
        filters.append(MemoryNode.derived_from_sources.any(source))

    stmt = select(MemoryNode).where(*filters)
    count_stmt = select(func.count()).select_from(MemoryNode).where(*filters)

    stmt = stmt.order_by(MemoryNode.updated_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    return MemoryNodeList(items=list(rows.scalars()), total=total)


@router.patch("/{node_id}", response_model=MemoryNodeRead)
async def update_memory_node(
    node_id: str,
    body: MemoryNodeUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    node = await session.get(MemoryNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")

    updates = body.model_dump(exclude_unset=True)
    if "title" in updates and updates["title"] is not None:
        node.title = updates["title"].strip()
    if "summary" in updates:
        node.summary = updates["summary"]
    if "content" in updates and updates["content"] is not None:
        node.content = updates["content"]
    if "status" in updates and updates["status"]:
        metadata = dict(node.metadata_ or {})
        metadata["status"] = updates["status"]
        node.metadata_ = metadata

    await session.commit()
    await session.refresh(node)
    return node


@router.post("/{node_id}/merge", response_model=MemoryNodeRead)
async def merge_memory_node(
    node_id: str,
    body: MemoryNodeMergeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(MemoryNode, node_id)
    target = await session.get(MemoryNode, body.target_node_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source memory node not found")
    if not target or target.user_id != user.id:
        raise HTTPException(status_code=404, detail="Target memory node not found")
    if source.id == target.id:
        raise HTTPException(status_code=422, detail="Cannot merge a memory node into itself")

    target.child_node_ids = _merge_unique(target.child_node_ids, [source.id], source.child_node_ids)
    target.derived_from_notes = _merge_unique(target.derived_from_notes, source.derived_from_notes)
    target.derived_from_sources = _merge_unique(target.derived_from_sources, source.derived_from_sources)
    target.derived_from_chunks = _merge_unique_int(target.derived_from_chunks, source.derived_from_chunks)
    target.summary = target.summary or source.summary
    if source.content and source.content not in (target.content or ""):
        target.content = (target.content or "").rstrip() + "\n\n## Merged Memory: " + source.title + "\n\n" + source.content
    metadata = dict(target.metadata_ or {})
    metadata.setdefault("merged_from", [])
    metadata["merged_from"] = _merge_unique(metadata.get("merged_from") or [], [source.id])
    target.metadata_ = metadata

    if body.archive_source:
        source_metadata = dict(source.metadata_ or {})
        source_metadata["status"] = "merged"
        source_metadata["merged_into"] = target.id
        source.metadata_ = source_metadata

    await session.commit()
    await session.refresh(target)
    return target


def _merge_unique(*values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for items in values:
        for item in items or []:
            if item and item not in seen:
                seen.add(item)
                merged.append(item)
    return merged


def _merge_unique_int(*values: list[int] | None) -> list[int]:
    seen: set[int] = set()
    merged: list[int] = []
    for items in values:
        for item in items or []:
            if item not in seen:
                seen.add(item)
                merged.append(item)
    return merged


@router.post("/topics/compile", response_model=MemoryNodeRead)
async def compile_topic_memory(
    body: TopicMemoryCompileRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        node = await compile_topic_memory_node(
            session,
            user_id=user.id,
            topic=body.topic.strip(),
            level=body.level,
            source_node_ids=body.source_node_ids,
            limit=body.limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    await session.refresh(node)
    return node


@router.get("/topics/candidates", response_model=TopicMemoryCandidateList)
async def topic_memory_candidates(
    topic: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    candidates = await preview_topic_memory_candidates(
        session,
        user_id=user.id,
        topic=topic.strip(),
        limit=limit,
    )
    items = [TopicMemoryCandidate(node=node, reason=reason) for node, reason in candidates]
    return TopicMemoryCandidateList(items=items, total=len(items))


@router.get("/{node_id}/edges", response_model=MemoryEdgeList)
async def list_memory_node_edges(
    node_id: str,
    direction: str = Query(default="both", pattern=r"^(in|out|both)$"),
    limit: int = Query(default=200, ge=1, le=500),
    refresh: bool = Query(default=False),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    node = await session.get(MemoryNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")
    if refresh:
        await sync_memory_edges_for_node(session, node)
        await session.commit()
    edges = await load_memory_edges(session, user_id=user.id, node_id=node_id, direction=direction, limit=limit)
    return MemoryEdgeList(items=edges, total=len(edges))


@router.get("/{node_id}/graph", response_model=MemoryGraphRead)
async def get_memory_node_graph(
    node_id: str,
    limit: int = Query(default=200, ge=1, le=500),
    refresh: bool = Query(default=False),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    node = await session.get(MemoryNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")
    if refresh:
        await sync_memory_edges_for_node(session, node)
        await session.commit()
    edges = await load_memory_edges(session, user_id=user.id, node_id=node_id, direction="both", limit=limit)
    memory_ids = {node_id}
    for edge in edges:
        memory_ids.add(edge.from_node_id)
        if edge.to_kind == "memory_node":
            memory_ids.add(edge.to_id)
    rows = await session.execute(select(MemoryNode).where(MemoryNode.user_id == user.id, MemoryNode.id.in_(memory_ids)))
    nodes = list(rows.scalars())
    return MemoryGraphRead(nodes=nodes, edges=edges)


@router.get("/{node_id}", response_model=MemoryNodeRead)
async def get_memory_node(
    node_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    node = await session.get(MemoryNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")
    return node
