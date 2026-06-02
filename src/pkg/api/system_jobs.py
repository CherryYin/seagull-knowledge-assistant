from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.system_job import SystemJobList
from pkg.services.system_jobs import list_system_jobs

router = APIRouter()


@router.get("", response_model=SystemJobList)
async def get_system_jobs(
    job_type: str | None = None,
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    items, total = await list_system_jobs(db, job_type=job_type, status=status, limit=limit, offset=offset)
    return SystemJobList(items=items, total=total)
