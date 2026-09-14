from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.calendar_reminder import CalendarReminder
from pkg.models.calendar_reminder_completion import CalendarReminderCompletion
from pkg.models.foundation.note import Note
from pkg.models.user import User
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderList, CalendarReminderRead, CalendarReminderUpdate

router = APIRouter()


def _today_key() -> str:
    return date.today().isoformat()


def _day_diff(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def _matches_recurrence(reminder: CalendarReminder, target_day: str) -> bool:
    if target_day < reminder.date:
        return False
    if reminder.recurrence == "once":
        return reminder.date == target_day
    delta = _day_diff(reminder.date, target_day)
    if reminder.recurrence == "daily":
        return delta >= 0
    if reminder.recurrence == "weekly":
        return delta >= 0 and delta % 7 == 0
    if reminder.recurrence == "biweekly":
        return delta >= 0 and delta % 14 == 0
    return False


async def _completion_dates_for_range(session: AsyncSession, *, user_id: str, start: str, end: str) -> set[tuple[str, str]]:
    rows = await session.execute(
        select(CalendarReminderCompletion.reminder_id, CalendarReminderCompletion.occurrence_date).where(
            CalendarReminderCompletion.user_id == user_id,
            CalendarReminderCompletion.occurrence_date >= start,
            CalendarReminderCompletion.occurrence_date <= end,
        )
    )
    return {(reminder_id, occurrence_date) for reminder_id, occurrence_date in rows.all()}


async def _attach_linked_notes(
    session: AsyncSession,
    *,
    user_id: str,
    reminders: list[CalendarReminder],
) -> None:
    note_ids = {reminder.note_id for reminder in reminders if reminder.note_id}
    if not note_ids:
        return
    rows = await session.execute(
        select(Note).where(Note.user_id == user_id, Note.id.in_(note_ids))
    )
    notes_by_id = {note.id: note for note in rows.scalars()}
    for reminder in reminders:
        reminder.linked_note = notes_by_id.get(reminder.note_id)


@router.get("", response_model=CalendarReminderList)
async def list_calendar_reminders(
    start: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    include_done: bool = True,
    note_id: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    filters = [CalendarReminder.user_id == user.id]
    if note_id:
        filters.append(CalendarReminder.note_id == note_id)

    rows = await session.execute(
        select(CalendarReminder).where(*filters).order_by(CalendarReminder.date.asc(), CalendarReminder.created_at.asc())
    )
    reminders = list(rows.scalars())
    if start or end:
        range_start = start or min((reminder.date for reminder in reminders), default=_today_key())
        range_end = end or max((reminder.date for reminder in reminders), default=_today_key())
        completion_dates = await _completion_dates_for_range(session, user_id=user.id, start=range_start, end=range_end)
        target_days: list[str] = []
        cursor = date.fromisoformat(range_start)
        last = date.fromisoformat(range_end)
        while cursor <= last:
          target_days.append(cursor.isoformat())
          cursor = cursor.fromordinal(cursor.toordinal() + 1)

        items: list[CalendarReminder] = []
        for reminder in reminders:
            matched_days = [day for day in target_days if _matches_recurrence(reminder, day)]
            if reminder.recurrence == "once":
                if matched_days and (include_done or not reminder.is_done):
                    items.append(reminder)
                continue
            for matched_day in matched_days:
                occurrence_done = (reminder.id, matched_day) in completion_dates or (reminder.recurrence == "once" and reminder.is_done)
                if not include_done and occurrence_done:
                    continue
                clone = CalendarReminder(
                    id=reminder.id,
                    user_id=reminder.user_id,
                    date=matched_day,
                    text=reminder.text,
                    note_id=reminder.note_id,
                    recurrence=reminder.recurrence,
                    is_done=occurrence_done,
                )
                clone.created_at = reminder.created_at
                clone.updated_at = reminder.updated_at
                items.append(clone)
    else:
        items = [reminder for reminder in reminders if include_done or not reminder.is_done]
    await _attach_linked_notes(session, user_id=user.id, reminders=items)
    overdue_filters = [
        CalendarReminder.user_id == user.id,
        CalendarReminder.is_done.is_(False),
        CalendarReminder.date < _today_key(),
    ]
    if note_id:
        overdue_filters.append(CalendarReminder.note_id == note_id)
    overdue_count = (await session.execute(
        select(func.count()).select_from(CalendarReminder).where(*overdue_filters)
    )).scalar() or 0
    return CalendarReminderList(items=items, total=len(items), overdue_count=overdue_count)


@router.post("", response_model=CalendarReminderRead, status_code=201)
async def create_calendar_reminder(
    body: CalendarReminderCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note_id = body.note_id
    note = None
    if note_id:
        note = await session.get(Note, note_id)
        if not note or note.user_id != user.id:
            raise HTTPException(status_code=404, detail="Note not found")
    reminder = CalendarReminder(
        user_id=user.id,
        date=body.date,
        text=body.text.strip(),
        note_id=note_id,
        recurrence=body.recurrence,
        is_done=False,
    )
    session.add(reminder)
    await session.commit()
    await session.refresh(reminder)
    reminder.linked_note = note
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
    linked_note = None
    if "text" in updates and updates["text"] is not None:
        reminder.text = updates["text"].strip()
    if "note_id" in updates:
        note_id = updates["note_id"]
        if note_id:
            linked_note = await session.get(Note, note_id)
            if not linked_note or linked_note.user_id != user.id:
                raise HTTPException(status_code=404, detail="Note not found")
        reminder.note_id = note_id
    if "recurrence" in updates and updates["recurrence"] is not None:
        reminder.recurrence = updates["recurrence"]
    if "is_done" in updates and updates["is_done"] is not None:
        occurrence_date = updates.get("occurrence_date") or reminder.date
        if (reminder.recurrence or "once") == "once":
            reminder.is_done = updates["is_done"]
        else:
            existing_completion = await session.execute(
                select(CalendarReminderCompletion).where(
                    CalendarReminderCompletion.reminder_id == reminder.id,
                    CalendarReminderCompletion.occurrence_date == occurrence_date,
                )
            )
            completion = existing_completion.scalar_one_or_none()
            if updates["is_done"]:
                if completion is None:
                    session.add(
                        CalendarReminderCompletion(
                            reminder_id=reminder.id,
                            user_id=user.id,
                            occurrence_date=occurrence_date,
                        )
                    )
            elif completion is not None:
                await session.delete(completion)
    await session.commit()
    await session.refresh(reminder)
    if reminder.note_id and linked_note is None:
        linked_note = await session.get(Note, reminder.note_id)
        if linked_note and linked_note.user_id != user.id:
            linked_note = None
    reminder.linked_note = linked_note
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
