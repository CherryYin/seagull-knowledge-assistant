from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.system_job import SystemJobList
from pkg.services.cross_cutting.system_jobs import list_system_jobs, sanitize_system_job

router = APIRouter()


@router.get("", response_model=SystemJobList)
async def get_system_jobs(
    job_type: str | None = None,
    status: str | None = None,
    scope: str = Query(default="mine", pattern=r"^(mine|global|all)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    effective_scope = scope if user.role == "admin" else "mine"
    include_all_users = effective_scope == "all"
    items, total = await list_system_jobs(
        db,
        user_id=user.id if effective_scope != "global" else None,
        include_global=effective_scope == "global",
        include_all_users=include_all_users,
        job_type=job_type,
        status=status,
        limit=limit,
        offset=offset,
    )
    include_sensitive = user.role == "admin"
    sanitized = [sanitize_system_job(item, include_sensitive=include_sensitive) for item in items]
    return SystemJobList(items=sanitized, total=total)
