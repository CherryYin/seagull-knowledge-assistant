from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderList, CalendarReminderRead, CalendarReminderUpdate
from pkg.schemas.application.project import TodoResourceList
from pkg.services.application import reminders, todo_resources
from pkg.services.application.reminders import _attach_linked_notes as _attach_linked_notes
from pkg.services.application.reminders import _matches_recurrence as _matches_recurrence
from pkg.services.application.reminders import _today_key as _today_key

router = APIRouter()


@router.get("/{reminder_id}/resources", response_model=TodoResourceList)
async def list_todo_resources(reminder_id: str, limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                             user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await todo_resources.list_resources(session, user_id=user.id, reminder_id=reminder_id, limit=limit, offset=offset)


@router.get("", response_model=CalendarReminderList)
async def list_calendar_reminders(
    start: date | None = None, end: date | None = None,
    include_done: bool = True, note_id: str | None = None,
    include_unscheduled: bool = False, unscheduled_only: bool = False, completed_only: bool = False,
    unassigned_only: bool = False,
    completion_start: date | None = None, completion_end: date | None = None,
    limit: int | None = Query(default=None, ge=1, le=100), offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session),
):
    return await reminders.list_reminders(session, user_id=user.id, start=start.isoformat() if start else None,
        end=end.isoformat() if end else None, include_done=include_done, note_id=note_id,
        include_unscheduled=include_unscheduled, unscheduled_only=unscheduled_only, completed_only=completed_only, unassigned_only=unassigned_only,
        completion_start=completion_start.isoformat() if completion_start else None,
        completion_end=completion_end.isoformat() if completion_end else None, limit=limit, offset=offset)


@router.post("", response_model=CalendarReminderRead, status_code=201)
async def create_calendar_reminder(body: CalendarReminderCreate, user: User = Depends(get_current_user),
                                   session: AsyncSession = Depends(get_session)):
    return await reminders.create_reminder(session, user_id=user.id, body=body)


@router.patch("/{reminder_id}", response_model=CalendarReminderRead)
async def update_calendar_reminder(reminder_id: str, body: CalendarReminderUpdate,
                                   user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await reminders.update_reminder(session, user_id=user.id, reminder_id=reminder_id, body=body)


@router.delete("/{reminder_id}", status_code=204)
async def delete_calendar_reminder(reminder_id: str, base_revision: int | None = Query(default=None, ge=1),
                                   user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await reminders.delete_reminder(session, user_id=user.id, reminder_id=reminder_id,
        base_revision=base_revision if isinstance(base_revision, int) else None)
