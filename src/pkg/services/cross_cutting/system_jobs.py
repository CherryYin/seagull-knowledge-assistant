from contextlib import asynccontextmanager
from datetime import datetime, timezone
from time import perf_counter
from typing import AsyncIterator

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import async_session
from pkg.models.system_job import SystemJob


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def sanitize_system_job(job: SystemJob, *, include_sensitive: bool) -> SystemJob:
    if include_sensitive:
        return job
    job.detail = None
    job.metadata_ = None
    if job.error_message and len(job.error_message) > 160:
        job.error_message = job.error_message[:157] + "..."
    return job


@asynccontextmanager
async def record_system_job(
    *,
    job_type: str,
    title: str,
    user_id: str | None = None,
    detail: str | None = None,
    metadata: dict | None = None,
) -> AsyncIterator[SystemJob]:
    started = perf_counter()
    async with async_session() as session:
        job = SystemJob(user_id=user_id, job_type=job_type, status="running", title=title, detail=detail, metadata_=metadata)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        try:
            yield job
        except Exception as exc:
            job.status = "failed"
            job.error_message = str(exc)
            job.ended_at = _utc_now_naive()
            job.duration_ms = round((perf_counter() - started) * 1000, 2)
            await session.commit()
            raise
        else:
            job.status = "completed"
            job.ended_at = _utc_now_naive()
            job.duration_ms = round((perf_counter() - started) * 1000, 2)
            await session.commit()


async def record_system_event(
    *,
    job_type: str,
    title: str,
    status: str,
    user_id: str | None = None,
    detail: str | None = None,
    metadata: dict | None = None,
    error_message: str | None = None,
    duration_ms: float | None = None,
) -> SystemJob:
    async with async_session() as session:
        now = _utc_now_naive()
        job = SystemJob(
            user_id=user_id,
            job_type=job_type,
            status=status,
            title=title,
            detail=detail,
            metadata_=metadata,
            error_message=error_message,
            duration_ms=duration_ms,
            started_at=now,
            ended_at=now,
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)
        return job


async def list_system_jobs(
    db: AsyncSession,
    *,
    user_id: str | None,
    include_global: bool = False,
    include_all_users: bool = False,
    job_type: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[SystemJob], int]:
    filters = []
    if not include_all_users:
        if user_id is None:
            filters.append(SystemJob.user_id.is_(None))
        elif include_global:
            filters.append((SystemJob.user_id == user_id) | SystemJob.user_id.is_(None))
        else:
            filters.append(SystemJob.user_id == user_id)
    if job_type:
        filters.append(SystemJob.job_type == job_type)
    if status:
        filters.append(SystemJob.status == status)
    total = (await db.execute(select(func.count()).select_from(SystemJob).where(*filters))).scalar() or 0
    rows = await db.execute(
        select(SystemJob)
        .where(*filters)
        .order_by(SystemJob.started_at.desc())
        .offset(offset)
        .limit(limit)
    )
    return list(rows.scalars()), total
