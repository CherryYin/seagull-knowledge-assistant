from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.calendar_reminder import CalendarReminder
from pkg.models.user import User
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderList, CalendarReminderRead, CalendarReminderUpdate

router = APIRouter()


def _today_key() -> str:
    return date.today().isoformat()


@router.get("", response_model=CalendarReminderList)
async def list_calendar_reminders(
    start: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    include_done: bool = True,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    filters = [CalendarReminder.user_id == user.id]
    if start:
        filters.append(CalendarReminder.date >= start)
    if end:
        filters.append(CalendarReminder.date <= end)
    if not include_done:
        filters.append(CalendarReminder.is_done.is_(False))

    rows = await session.execute(
        select(CalendarReminder).where(*filters).order_by(CalendarReminder.date.asc(), CalendarReminder.created_at.asc())
    )
    items = list(rows.scalars())
    overdue_count = (await session.execute(
        select(func.count()).select_from(CalendarReminder).where(
            CalendarReminder.user_id == user.id,
            CalendarReminder.is_done.is_(False),
            CalendarReminder.date < _today_key(),
        )
    )).scalar() or 0
    return CalendarReminderList(items=items, total=len(items), overdue_count=overdue_count)


@router.post("", response_model=CalendarReminderRead, status_code=201)
async def create_calendar_reminder(
    body: CalendarReminderCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    reminder = CalendarReminder(user_id=user.id, date=body.date, text=body.text.strip(), is_done=False)
    session.add(reminder)
    await session.commit()
    await session.refresh(reminder)
    return reminder


@router.patch("/{reminder_id}", response_model=CalendarReminderRead)
async def update_calendar_reminder(
    reminder_id: str,
    body: CalendarReminderUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    reminder = await session.get(CalendarReminder, reminder_id)
    if not reminder or reminder.user_id != user.id:
        raise HTTPException(status_code=404, detail="Reminder not found")
    updates = body.model_dump(exclude_unset=True)
    if "text" in updates and updates["text"] is not None:
        reminder.text = updates["text"].strip()
    if "is_done" in updates and updates["is_done"] is not None:
        reminder.is_done = updates["is_done"]
    await session.commit()
    await session.refresh(reminder)
    return reminder


@router.delete("/{reminder_id}", status_code=204)
async def delete_calendar_reminder(
    reminder_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    reminder = await session.get(CalendarReminder, reminder_id)
    if not reminder or reminder.user_id != user.id:
        raise HTTPException(status_code=404, detail="Reminder not found")
    await session.delete(reminder)
    await session.commit()
