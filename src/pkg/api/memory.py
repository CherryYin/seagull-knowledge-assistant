from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.foundation.memory import MemoryEmbedding, MemoryNode
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
from pkg.services.foundation.memory_edges import load_memory_edges, sync_memory_edges_for_node
from pkg.services.foundation.memory_lifecycle import (
    ACTIVE_MEMORY_STATUS,
    mark_memory_merged,
    record_memory_merge_target,
    set_memory_status,
)
from pkg.services.foundation.memory_tree import compile_topic_memory_node, preview_topic_memory_candidates

router = APIRouter()


def _apply_memory_filters(*, stmt, user_id: str, node_type: str | None, level: str | None, scope_id: str | None, q: str | None, status: str | None, has_embedding: bool | None, stale: bool | None, source: str | None):
    filters = [MemoryNode.user_id == user_id]

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
        if status in {"archived", "pending_review", "rejected", "merged"}:
            filters.append(MemoryNode.metadata_["status"].astext == status)
        else:
            filters.append(or_(
                MemoryNode.metadata_.is_(None),
                ~MemoryNode.metadata_.has_key("status"),  # noqa: W601
                MemoryNode.metadata_["status"].astext == ACTIVE_MEMORY_STATUS,
            ))
    if has_embedding is not None:
        embedding_exists = exists().where(MemoryEmbedding.memory_node_id == MemoryNode.id)
        filters.append(embedding_exists if has_embedding else ~embedding_exists)
    if stale is not None:
        stale_filter = MemoryNode.metadata_["stale"].astext == "true"
        filters.append(stale_filter if stale else or_(
            MemoryNode.metadata_.is_(None),
            ~MemoryNode.metadata_.has_key("stale"),  # noqa: W601
            MemoryNode.metadata_["stale"].astext != "true",
        ))
    if source:
        filters.append(MemoryNode.derived_from_sources.any(source))

    return stmt.where(*filters)


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
    stmt = _apply_memory_filters(
        stmt=select(MemoryNode),
        user_id=user.id,
        node_type=node_type,
        level=level,
        scope_id=scope_id,
        q=q,
        status=status,
        has_embedding=has_embedding,
        stale=stale,
        source=source,
    )
    count_stmt = _apply_memory_filters(
        stmt=select(func.count()).select_from(MemoryNode),
        user_id=user.id,
        node_type=node_type,
        level=level,
        scope_id=scope_id,
        q=q,
        status=status,
        has_embedding=has_embedding,
        stale=stale,
        source=source,
    )

    stmt = stmt.order_by(MemoryNode.updated_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    return MemoryNodeList(items=list(rows.scalars()), total=total)


@router.get("/roots", response_model=MemoryNodeList)
async def list_memory_roots(
    node_type: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, pattern=r"^(active|archived|pending_review|rejected|merged)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    child_id_subquery = select(func.unnest(MemoryNode.child_node_ids))
    stmt = _apply_memory_filters(
        stmt=select(MemoryNode).where(not_(MemoryNode.id.in_(child_id_subquery))),
        user_id=user.id,
        node_type=node_type,
        level=None,
        scope_id=None,
        q=q,
        status=status,
        has_embedding=None,
        stale=None,
        source=None,
    )
    count_stmt = _apply_memory_filters(
        stmt=select(func.count()).select_from(MemoryNode).where(not_(MemoryNode.id.in_(child_id_subquery))),
        user_id=user.id,
        node_type=node_type,
        level=None,
        scope_id=None,
        q=q,
        status=status,
        has_embedding=None,
        stale=None,
        source=None,
    )
    stmt = stmt.order_by(MemoryNode.updated_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    return MemoryNodeList(items=list(rows.scalars()), total=total)


@router.get("/{node_id}/children", response_model=MemoryNodeList)
async def list_memory_children(
    node_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    node = await session.get(MemoryNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")
    if not node.child_node_ids:
        return MemoryNodeList(items=[], total=0)
    rows = await session.execute(
        select(MemoryNode)
        .where(MemoryNode.user_id == user.id, MemoryNode.id.in_(node.child_node_ids))
        .order_by(MemoryNode.title.asc())
    )
    items = list(rows.scalars())
    items_by_id = {item.id: item for item in items}
    ordered = [items_by_id[child_id] for child_id in node.child_node_ids if child_id in items_by_id]
    return MemoryNodeList(items=ordered, total=len(ordered))


@router.get("/{node_id}/path", response_model=MemoryNodeList)
async def get_memory_node_path(
    node_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    target = await session.get(MemoryNode, node_id)
    if not target or target.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")

    rows = await session.execute(select(MemoryNode).where(MemoryNode.user_id == user.id))
    nodes = list(rows.scalars())
    by_id = {node.id: node for node in nodes}
    parent_by_child: dict[str, str] = {}
    for node in nodes:
        for child_id in node.child_node_ids or []:
            parent_by_child.setdefault(child_id, node.id)

    path_ids: list[str] = []
    current_id = node_id
    seen: set[str] = set()
    while current_id and current_id not in seen:
        seen.add(current_id)
        path_ids.append(current_id)
        current_id = parent_by_child.get(current_id, "")

    path_ids.reverse()
    items = [by_id[item_id] for item_id in path_ids if item_id in by_id]
    return MemoryNodeList(items=items, total=len(items))


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
        set_memory_status(node, updates["status"])

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
    record_memory_merge_target(target, source_node_id=source.id)

    if body.archive_source:
        mark_memory_merged(source, target_node_id=target.id)

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
