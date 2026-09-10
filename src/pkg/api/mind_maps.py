from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.application.mind_map import (
    MindMap,
    MindMapNode,
    MindMapNodeReference,
    MindMapRevision,
)
from pkg.models.user import User
from pkg.schemas.application.mind_map import (
    MindMapCreate,
    MindMapDelete,
    MindMapList,
    MindMapMutationResult,
    MindMapNodeCreate,
    MindMapNodeDelete,
    MindMapNodeMove,
    MindMapNodeRead,
    MindMapNodeUpdate,
    MindMapOutlineApply,
    MindMapOutlineApplyResult,
    MindMapOwnerType,
    MindMapPurpose,
    MindMapRead,
    MindMapReferenceCreate,
    MindMapReferenceDelete,
    MindMapReferenceList,
    MindMapReferenceRead,
    MindMapReferenceType,
    MindMapReferenceUpdate,
    MindMapRevisionList,
    MindMapRevisionRead,
    MindMapRevisionRestore,
    MindMapStalenessRead,
    MindMapTreeRead,
    MindMapUpdate,
    MindMapVersionConflictResponse,
    SourceMindMapGenerationContextRead,
    SourceMindMapProposalApply,
    SourceMindMapProposalValidate,
    SourceMindMapProposalValidationRead,
)
from pkg.services.application.mind_maps import (
    MindMapMutationState,
    MindMapSummaryState,
    MindMapTreeState,
    add_mind_map_node,
    apply_mind_map_outline,
    apply_source_mind_map_proposal,
    build_source_mind_map_generation_context,
    check_source_mind_map_staleness,
    create_mind_map_reference,
    create_mind_map,
    delete_mind_map_reference,
    delete_mind_map,
    delete_mind_map_node,
    get_mind_map_revision,
    get_mind_map_summary,
    get_mind_map_tree,
    list_mind_map_revisions,
    list_mind_map_references_by_target,
    list_mind_maps,
    move_mind_map_node,
    restore_mind_map_revision,
    update_mind_map,
    update_mind_map_reference,
    update_mind_map_node,
    validate_source_mind_map_proposal,
)


router = APIRouter()
VERSION_CONFLICT_RESPONSES = {
    409: {
        "model": MindMapVersionConflictResponse,
        "description": "The supplied base_version no longer matches the Mind Map.",
    }
}


def _map_read(mind_map: MindMap, root_id: str) -> MindMapRead:
    return MindMapRead(
        id=mind_map.id,
        user_id=mind_map.user_id,
        owner_type=mind_map.owner_type,
        owner_id=mind_map.owner_id,
        purpose=mind_map.purpose,
        title=mind_map.title,
        root_node_id=root_id,
        layout_mode=mind_map.layout_mode,
        version=mind_map.version,
        basis_revision=mind_map.basis_revision or {},
        generation_status=mind_map.generation_status,
        created_at=mind_map.created_at,
        updated_at=mind_map.updated_at,
    )


def _node_read(node: MindMapNode) -> MindMapNodeRead:
    return MindMapNodeRead.model_validate(node)


def _reference_read(reference: MindMapNodeReference) -> MindMapReferenceRead:
    return MindMapReferenceRead.model_validate(reference)


def _revision_read(revision: MindMapRevision) -> MindMapRevisionRead:
    return MindMapRevisionRead.model_validate(revision)


def _summary_read(summary: MindMapSummaryState) -> MindMapRead:
    return _map_read(summary.map, summary.root_id)


def _tree_read(tree: MindMapTreeState) -> MindMapTreeRead:
    return MindMapTreeRead(
        map=_map_read(tree.map, tree.root_id),
        root_id=tree.root_id,
        nodes=[_node_read(node) for node in tree.nodes],
        references=[_reference_read(reference) for reference in tree.references],
    )


def _mutation_read(result: MindMapMutationState) -> MindMapMutationResult:
    return MindMapMutationResult(
        map_id=result.map.id,
        previous_version=result.previous_version,
        current_version=result.current_version,
        revision=_revision_read(result.revision),
        node=_node_read(result.node) if result.node is not None else None,
        reference=(
            _reference_read(result.reference)
            if result.reference is not None
            else None
        ),
        deleted_node_ids=list(result.deleted_node_ids),
    )


def _outline_mutation_read(
    result: MindMapMutationState,
) -> MindMapOutlineApplyResult:
    if result.outline_mode is None:
        raise ValueError("Outline mutation result is missing its mode")
    mutation = _mutation_read(result)
    return MindMapOutlineApplyResult(
        **mutation.model_dump(),
        mode=result.outline_mode,
        created_count=result.created_count,
        updated_count=result.updated_count,
        moved_count=result.moved_count,
        deleted_count=result.deleted_count,
    )


@router.get("", response_model=MindMapList)
async def list_mind_maps_route(
    owner_type: MindMapOwnerType | None = None,
    owner_id: str | None = None,
    purpose: MindMapPurpose | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapList:
    items, total = await list_mind_maps(
        session,
        user_id=user.id,
        owner_type=owner_type,
        owner_id=owner_id,
        purpose=purpose,
        limit=limit,
        offset=offset,
    )
    return MindMapList(items=[_summary_read(item) for item in items], total=total)


@router.post("", response_model=MindMapTreeRead, status_code=status.HTTP_201_CREATED)
async def create_mind_map_route(
    body: MindMapCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapTreeRead:
    tree = await create_mind_map(session, user_id=user.id, body=body)
    return _tree_read(tree)


@router.get("/references", response_model=MindMapReferenceList)
async def list_mind_map_references_by_target_route(
    ref_type: MindMapReferenceType,
    ref_id: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapReferenceList:
    items, total = await list_mind_map_references_by_target(
        session,
        user_id=user.id,
        ref_type=ref_type,
        ref_id=ref_id,
        limit=limit,
        offset=offset,
    )
    return MindMapReferenceList(
        items=[_reference_read(reference) for reference in items],
        total=total,
    )


@router.get(
    "/proposals/source/context",
    response_model=SourceMindMapGenerationContextRead,
)
async def get_source_mind_map_generation_context_route(
    source_id: str = Query(min_length=1, max_length=200),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> SourceMindMapGenerationContextRead:
    return await build_source_mind_map_generation_context(
        session,
        user_id=user.id,
        source_id=source_id,
    )


@router.get("/{map_id}", response_model=MindMapRead)
async def get_mind_map_route(
    map_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapRead:
    summary = await get_mind_map_summary(session, user_id=user.id, map_id=map_id)
    return _summary_read(summary)


@router.post(
    "/proposals/source/validate",
    response_model=SourceMindMapProposalValidationRead,
)
async def validate_source_mind_map_proposal_route(
    body: SourceMindMapProposalValidate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> SourceMindMapProposalValidationRead:
    result = await validate_source_mind_map_proposal(
        session,
        user_id=user.id,
        body=body,
    )
    return SourceMindMapProposalValidationRead(
        source_id=result.source_id,
        basis_revision=result.basis_revision,
        proposal=result.proposal,
        map_id=body.map_id,
        base_version=body.base_version,
        target_node_id=body.target_node_id,
        node_count=result.node_count,
        reference_count=result.reference_count,
    )


@router.post(
    "/proposals/source/apply",
    response_model=MindMapTreeRead,
)
async def apply_source_mind_map_proposal_route(
    body: SourceMindMapProposalApply,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapTreeRead:
    tree = await apply_source_mind_map_proposal(session, user_id=user.id, body=body)
    return _tree_read(tree)


@router.post("/{map_id}/check-staleness", response_model=MindMapStalenessRead)
async def check_mind_map_staleness_route(
    map_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapStalenessRead:
    result = await check_source_mind_map_staleness(
        session,
        user_id=user.id,
        map_id=map_id,
    )
    return MindMapStalenessRead(
        map=_map_read(result.map, result.root_id),
        stale=result.stale,
        reasons=list(result.reasons),
        current_basis=result.current_basis,
    )


@router.patch(
    "/{map_id}",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def update_mind_map_route(
    map_id: str,
    body: MindMapUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await update_mind_map(session, user_id=user.id, map_id=map_id, body=body)
    return _mutation_read(result)


@router.delete(
    "/{map_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def delete_mind_map_route(
    map_id: str,
    body: MindMapDelete,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    await delete_mind_map(session, user_id=user.id, map_id=map_id, body=body)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{map_id}/tree", response_model=MindMapTreeRead)
async def get_mind_map_tree_route(
    map_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapTreeRead:
    tree = await get_mind_map_tree(session, user_id=user.id, map_id=map_id)
    return _tree_read(tree)


@router.post(
    "/{map_id}/nodes",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def add_mind_map_node_route(
    map_id: str,
    body: MindMapNodeCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await add_mind_map_node(
        session,
        user_id=user.id,
        map_id=map_id,
        body=body,
    )
    return _mutation_read(result)


@router.patch(
    "/{map_id}/nodes/{node_id}",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def update_mind_map_node_route(
    map_id: str,
    node_id: str,
    body: MindMapNodeUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await update_mind_map_node(
        session,
        user_id=user.id,
        map_id=map_id,
        node_id=node_id,
        body=body,
    )
    return _mutation_read(result)


@router.post(
    "/{map_id}/nodes/{node_id}/move",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def move_mind_map_node_route(
    map_id: str,
    node_id: str,
    body: MindMapNodeMove,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await move_mind_map_node(
        session,
        user_id=user.id,
        map_id=map_id,
        node_id=node_id,
        body=body,
    )
    return _mutation_read(result)


@router.delete(
    "/{map_id}/nodes/{node_id}",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def delete_mind_map_node_route(
    map_id: str,
    node_id: str,
    body: MindMapNodeDelete,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await delete_mind_map_node(
        session,
        user_id=user.id,
        map_id=map_id,
        node_id=node_id,
        body=body,
    )
    return _mutation_read(result)


@router.post(
    "/{map_id}/outline/apply",
    response_model=MindMapOutlineApplyResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def apply_mind_map_outline_route(
    map_id: str,
    body: MindMapOutlineApply,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapOutlineApplyResult:
    result = await apply_mind_map_outline(
        session,
        user_id=user.id,
        map_id=map_id,
        body=body,
    )
    return _outline_mutation_read(result)


@router.post(
    "/{map_id}/nodes/{node_id}/references",
    response_model=MindMapMutationResult,
    status_code=status.HTTP_201_CREATED,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def create_mind_map_reference_route(
    map_id: str,
    node_id: str,
    body: MindMapReferenceCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await create_mind_map_reference(
        session,
        user_id=user.id,
        map_id=map_id,
        node_id=node_id,
        body=body,
    )
    return _mutation_read(result)


@router.patch(
    "/{map_id}/nodes/{node_id}/references/{reference_id}",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def update_mind_map_reference_route(
    map_id: str,
    node_id: str,
    reference_id: str,
    body: MindMapReferenceUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await update_mind_map_reference(
        session,
        user_id=user.id,
        map_id=map_id,
        node_id=node_id,
        reference_id=reference_id,
        body=body,
    )
    return _mutation_read(result)


@router.delete(
    "/{map_id}/nodes/{node_id}/references/{reference_id}",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def delete_mind_map_reference_route(
    map_id: str,
    node_id: str,
    reference_id: str,
    body: MindMapReferenceDelete,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await delete_mind_map_reference(
        session,
        user_id=user.id,
        map_id=map_id,
        node_id=node_id,
        reference_id=reference_id,
        body=body,
    )
    return _mutation_read(result)


@router.get("/{map_id}/revisions", response_model=MindMapRevisionList)
async def list_mind_map_revisions_route(
    map_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapRevisionList:
    items, total = await list_mind_map_revisions(
        session,
        user_id=user.id,
        map_id=map_id,
        limit=limit,
        offset=offset,
    )
    return MindMapRevisionList(items=[_revision_read(item) for item in items], total=total)


@router.get("/{map_id}/revisions/{version}", response_model=MindMapRevisionRead)
async def get_mind_map_revision_route(
    map_id: str,
    version: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapRevisionRead:
    revision = await get_mind_map_revision(
        session,
        user_id=user.id,
        map_id=map_id,
        version=version,
    )
    return _revision_read(revision)


@router.post(
    "/{map_id}/revisions/{version}/restore",
    response_model=MindMapMutationResult,
    responses=VERSION_CONFLICT_RESPONSES,
)
async def restore_mind_map_revision_route(
    map_id: str,
    version: int,
    body: MindMapRevisionRestore,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MindMapMutationResult:
    result = await restore_mind_map_revision(
        session,
        user_id=user.id,
        map_id=map_id,
        version=version,
        body=body,
    )
    return _mutation_read(result)
