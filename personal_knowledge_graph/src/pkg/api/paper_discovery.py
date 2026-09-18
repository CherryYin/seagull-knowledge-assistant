from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.paper_discovery import PaperDiscoveryProfile, PaperDiscoveryRun, PaperTrendSnapshot
from pkg.models.user import User
from pkg.schemas.paper_discovery import (
    PaperDiscoveryExecuteRequest,
    PaperDiscoveryPreviewRequest,
    PaperDiscoveryProfileCreate,
    PaperDiscoveryProfileList,
    PaperDiscoveryProfileRead,
    PaperDiscoveryProfileUpdate,
    PaperDiscoveryRunList,
    PaperDiscoveryRunRead,
    PaperTrendSnapshotList,
)
from pkg.schemas.discovery import DiscoveryItemList
from pkg.services.foundation.paper_discovery import execute_profile_run, get_paper_discovery_profile, list_profile_candidates, preview_profile_queries

router = APIRouter()


@router.get("/profiles", response_model=PaperDiscoveryProfileList)
async def list_paper_discovery_profiles(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    row = await session.execute(
        select(PaperDiscoveryProfile)
        .where(PaperDiscoveryProfile.user_id == user.id)
        .order_by(PaperDiscoveryProfile.updated_at.desc())
    )
    items = list(row.scalars())
    return PaperDiscoveryProfileList(items=items, total=len(items))


@router.post("/profiles", response_model=PaperDiscoveryProfileRead, status_code=201)
async def create_paper_discovery_profile(
    body: PaperDiscoveryProfileCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    item = PaperDiscoveryProfile(user_id=user.id, **body.model_dump())
    session.add(item)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Paper discovery profile name already exists") from exc
    await session.refresh(item)
    return item


@router.patch("/profiles/{profile_id}", response_model=PaperDiscoveryProfileRead)
async def update_paper_discovery_profile(
    profile_id: int,
    body: PaperDiscoveryProfileUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    item = await get_paper_discovery_profile(session, user_id=user.id, profile_id=profile_id)
    if not item:
        raise HTTPException(status_code=404, detail="Paper discovery profile not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    await session.commit()
    await session.refresh(item)
    return item


@router.post("/profiles/{profile_id}/preview")
async def preview_paper_discovery_profile(
    profile_id: int,
    _body: PaperDiscoveryPreviewRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        return await preview_profile_queries(session, user_id=user.id, profile_id=profile_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/profiles/{profile_id}/run", response_model=PaperDiscoveryRunRead)
async def run_paper_discovery_profile(
    profile_id: int,
    body: PaperDiscoveryExecuteRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        run, _items, _created, _updated = await execute_profile_run(
            session,
            user_id=user.id,
            profile_id=profile_id,
            mode=body.mode,
            limit=body.limit,
        )
        return run
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        raise HTTPException(status_code=500, detail=f"Paper discovery run failed: {exc}") from exc


@router.get("/profiles/{profile_id}/runs", response_model=PaperDiscoveryRunList)
async def list_paper_discovery_runs(
    profile_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await get_paper_discovery_profile(session, user_id=user.id, profile_id=profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Paper discovery profile not found")
    row = await session.execute(
        select(PaperDiscoveryRun)
        .where(PaperDiscoveryRun.user_id == user.id, PaperDiscoveryRun.profile_id == profile_id)
        .order_by(PaperDiscoveryRun.started_at.desc())
    )
    items = list(row.scalars())
    return PaperDiscoveryRunList(items=items, total=len(items))


@router.get("/profiles/{profile_id}/candidates", response_model=DiscoveryItemList)
async def list_paper_discovery_candidates(
    profile_id: int,
    limit: int = 50,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        items = await list_profile_candidates(session, user_id=user.id, profile_id=profile_id, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return DiscoveryItemList(items=items, total=len(items))


@router.get("/profiles/{profile_id}/trends", response_model=PaperTrendSnapshotList)
async def list_paper_discovery_trends(
    profile_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await get_paper_discovery_profile(session, user_id=user.id, profile_id=profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Paper discovery profile not found")
    row = await session.execute(
        select(PaperTrendSnapshot)
        .where(PaperTrendSnapshot.user_id == user.id, PaperTrendSnapshot.profile_id == profile_id)
        .order_by(PaperTrendSnapshot.created_at.desc())
    )
    items = list(row.scalars())
    return PaperTrendSnapshotList(items=items, total=len(items))
