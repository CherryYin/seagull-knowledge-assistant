from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import async_session
from pkg.models.agent_profile import AgentProfile
from pkg.models.agent_run import AgentRun, AgentRunEvent

FINISHED_STATUSES = {"completed", "failed", "cancelled"}
RUNNING_STATUSES = {
    "queued",
    "running",
    "thinking",
    "searching",
    "reading",
    "writing",
    "tool_calling",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _preview(text: str | None, max_length: int = 500) -> str | None:
    if text is None:
        return None
    clean = text.strip()
    if len(clean) <= max_length:
        return clean
    return clean[: max_length - 1].rstrip() + "…"


async def start_run(
    user_id: str,
    profile_id: str | None,
    agent_type: str,
    task: str,
) -> AgentRun:
    now = _utc_now()
    async with async_session() as db:
        run = AgentRun(
            user_id=user_id,
            profile_id=profile_id,
            agent_type=agent_type,
            status="running",
            task=task,
            started_at=now,
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        return run


async def update_run_status(
    run_id: str,
    status: str,
    summary: str | None = None,
    result_preview: str | None = None,
    error_message: str | None = None,
) -> AgentRun | None:
    async with async_session() as db:
        run = await db.get(AgentRun, run_id)
        if run is None:
            return None
        run.status = status
        if summary is not None:
            run.summary = summary
        if result_preview is not None:
            run.result_preview = _preview(result_preview)
        if error_message is not None:
            run.error_message = error_message
        if status in FINISHED_STATUSES and run.ended_at is None:
            run.ended_at = _utc_now()
        await db.commit()
        await db.refresh(run)
        return run


async def add_run_event(
    run_id: str,
    user_id: str,
    event_type: str,
    title: str,
    detail: str | None = None,
    metadata: dict | None = None,
) -> AgentRunEvent:
    async with async_session() as db:
        event = AgentRunEvent(
            run_id=run_id,
            user_id=user_id,
            event_type=event_type,
            title=title[:200],
            detail=detail,
            metadata_=metadata,
        )
        db.add(event)
        await db.commit()
        await db.refresh(event)
        return event


async def complete_run(run_id: str, result_preview: str | None = None) -> AgentRun | None:
    run = await update_run_status(run_id, "completed", result_preview=result_preview)
    if run is not None:
        await add_run_event(
            run_id=run.id,
            user_id=run.user_id,
            event_type="completed",
            title="Run completed",
            detail=_preview(result_preview),
        )
        try:
            from pkg.services.agent_memory import extract_pending_memory_from_agent_run

            async with async_session() as db:
                fresh_run = await db.get(AgentRun, run.id)
                if fresh_run is not None:
                    memory = await extract_pending_memory_from_agent_run(
                        db,
                        run=fresh_run,
                        result_preview=result_preview,
                    )
                    if memory is not None:
                        db.add(
                            AgentRunEvent(
                                run_id=run.id,
                                user_id=run.user_id,
                                event_type="memory_extracted",
                                title="Pending memory extracted",
                                detail=memory.title,
                                metadata_={"memory_node_id": memory.id, "requires_review": True},
                            )
                        )
                    await db.commit()
        except Exception:
            # Memory extraction must never make a completed agent run fail.
            pass
    return run


async def fail_run(run_id: str, error_message: str) -> AgentRun | None:
    run = await update_run_status(run_id, "failed", error_message=error_message)
    if run is not None:
        await add_run_event(
            run_id=run.id,
            user_id=run.user_id,
            event_type="error",
            title="Run failed",
            detail=error_message,
        )
    return run


async def list_runs(
    db: AsyncSession,
    user_id: str,
    profile_id: str | None = None,
    agent_type: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[AgentRun], int]:
    filters = [AgentRun.user_id == user_id]
    if profile_id:
        filters.append(AgentRun.profile_id == profile_id)
    if agent_type:
        filters.append(AgentRun.agent_type == agent_type)
    if status:
        filters.append(AgentRun.status == status)

    total_stmt = select(func.count()).select_from(AgentRun).where(*filters)
    total = (await db.execute(total_stmt)).scalar() or 0
    stmt = (
        select(AgentRun)
        .where(*filters)
        .order_by(AgentRun.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    rows = await db.execute(stmt)
    return list(rows.scalars()), total


async def list_run_events(
    db: AsyncSession,
    run_id: str,
    user_id: str,
    limit: int = 200,
    offset: int = 0,
) -> list[AgentRunEvent]:
    stmt = (
        select(AgentRunEvent)
        .where(AgentRunEvent.run_id == run_id, AgentRunEvent.user_id == user_id)
        .order_by(AgentRunEvent.created_at.asc())
        .offset(offset)
        .limit(limit)
    )
    rows = await db.execute(stmt)
    return list(rows.scalars())


async def get_workspace_status(db: AsyncSession, user_id: str) -> list[dict]:
    profiles_result = await db.execute(
        select(AgentProfile).where(AgentProfile.user_id == user_id).order_by(AgentProfile.name.asc())
    )
    profiles = list(profiles_result.scalars())
    statuses: list[dict] = []
    for profile in profiles:
        run_result = await db.execute(
            select(AgentRun)
            .where(AgentRun.user_id == user_id, AgentRun.profile_id == profile.id)
            .order_by(AgentRun.updated_at.desc())
            .limit(1)
        )
        latest = run_result.scalar_one_or_none()
        statuses.append(
            {
                "profile_id": profile.id,
                "profile_name": profile.name,
                "agent_type": profile.agent_type,
                "status": latest.status if latest else "idle",
                "current_task": latest.task if latest else None,
                "last_active_at": latest.updated_at if latest else None,
                "last_result_preview": latest.result_preview if latest else None,
                "run_id": latest.id if latest else None,
            }
        )
    return statuses
