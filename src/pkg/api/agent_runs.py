from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.agent_run import AgentRun
from pkg.models.user import User
from pkg.schemas.agent_run import (
    AgentRunEventRead,
    AgentRunList,
    AgentRunRead,
    AgentRunStatusRead,
)
from pkg.services.agent_runs import get_workspace_status, list_run_events, list_runs

router = APIRouter()


@router.get("/status", response_model=list[AgentRunStatusRead])
async def get_agent_run_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    return await get_workspace_status(db, user.id)


@router.get("", response_model=AgentRunList)
async def get_agent_runs(
    profile_id: str | None = None,
    agent_type: str | None = None,
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    items, total = await list_runs(
        db=db,
        user_id=user.id,
        profile_id=profile_id,
        agent_type=agent_type,
        status=status,
        limit=limit,
        offset=offset,
    )
    return AgentRunList(items=items, total=total)


@router.get("/{run_id}", response_model=AgentRunRead)
async def get_agent_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    run = await db.get(AgentRun, run_id)
    if run is None or run.user_id != user.id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return run


@router.get("/{run_id}/events", response_model=list[AgentRunEventRead])
async def get_agent_run_events(
    run_id: str,
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    run = await db.get(AgentRun, run_id)
    if run is None or run.user_id != user.id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return await list_run_events(db, run_id, user.id, limit=limit, offset=offset)
