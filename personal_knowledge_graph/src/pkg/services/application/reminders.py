from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.project import Project, ProjectResource
from pkg.models.calendar_reminder import CalendarReminder, CalendarReminderNote
from pkg.models.calendar_reminder_completion import CalendarReminderCompletion
from pkg.models.foundation.note import Note
from pkg.schemas.application.project import ProjectResourceInput
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderList, CalendarReminderRead, CalendarReminderUpdate, ProjectTaskList
from pkg.services.application import projects


def _today_key():
    return date.today().isoformat()


def _matches_recurrence(reminder, target_day):
    if reminder.date is None or target_day < reminder.date:
        return False
    delta = (date.fromisoformat(target_day) - date.fromisoformat(reminder.date)).days
    if (reminder.recurrence or "once") == "once":
        return delta == 0
    interval = {"daily": 1, "weekly": 7, "biweekly": 14}.get(reminder.recurrence)
    return interval is not None and delta % interval == 0


async def _attach_linked_notes(session, *, user_id, reminders):
    if not reminders:
        return
    rows = await session.execute(select(CalendarReminderNote.reminder_id, Note)
        .join(Note, Note.id == CalendarReminderNote.note_id)
        .where(CalendarReminderNote.reminder_id.in_({reminder.id for reminder in reminders}), Note.user_id == user_id)
        .order_by(CalendarReminderNote.reminder_id, CalendarReminderNote.position))
    grouped = {}
    for reminder_id, note in rows.all():
        grouped.setdefault(reminder_id, []).append(note)
    for reminder in reminders:
        _set_notes(reminder, grouped.get(reminder.id, []))


def _set_notes(reminder, notes):
    reminder.linked_notes = notes
    reminder.note_ids = [note.id for note in notes]
    reminder.linked_note = notes[0] if notes else None
    reminder.note_id = notes[0].id if notes else None


async def _load_notes(session, user_id, note_ids):
    notes = []
    for note_id in dict.fromkeys(note_id for note_id in note_ids if note_id):
        note = await session.get(Note, note_id)
        if note is None or note.user_id != user_id:
            raise HTTPException(404, "Note not found")
        notes.append(note)
    return notes


async def _hydrate(session, user_id, reminders):
    await _attach_linked_notes(session, user_id=user_id, reminders=reminders)
    project_ids = {reminder.project_id for reminder in reminders if reminder.project_id}
    revisions = {}
    if project_ids:
        rows = await session.execute(select(Project.id, Project.revision).where(Project.id.in_(project_ids), Project.user_id == user_id))
        revisions = dict(rows.all())
    for reminder in reminders:
        reminder.project_revision = revisions.get(reminder.project_id)


def _revision(project, revision):
    if revision is None:
        raise HTTPException(422, "Project relationship changes require base_revision")
    projects.check_revision(project, revision)


async def _join_notes(session, user_id, project_id, notes):
    if not notes:
        return
    refs = [ProjectResourceInput(resource_type="note", resource_id=note.id) for note in notes]
    await projects._load_targets(session, user_id, refs, lock=True)
    existing = set((await session.execute(select(ProjectResource.note_id).where(ProjectResource.project_id == project_id,
        ProjectResource.resource_type == "note"))).scalars())
    for note in notes:
        if note.id not in existing:
            session.add(ProjectResource(project_id=project_id, resource_type="note", note_id=note.id, reason="Task context"))


async def create_reminder(session: AsyncSession, *, user_id, body: CalendarReminderCreate):
    project = None
    if body.project_id:
        project = await projects.owned_project(session, user_id, body.project_id, lock=True)
        _revision(project, body.base_revision)
    note_ids = body.note_ids if body.note_ids is not None else [body.note_id]
    notes = await _load_notes(session, user_id, note_ids)
    reminder = CalendarReminder(user_id=user_id, date=body.date, text=body.text, recurrence=body.recurrence,
        project_id=body.project_id, completed_at=None, note_id=notes[0].id if notes else None, is_done=False)
    session.add(reminder)
    await session.flush()
    for position, note in enumerate(notes):
        session.add(CalendarReminderNote(reminder_id=reminder.id, note_id=note.id, position=position))
    if project:
        await _join_notes(session, user_id, project.id, notes)
        projects._advance(project)
    await session.commit()
    await session.refresh(reminder)
    _set_notes(reminder, notes)
    reminder.project_revision = project.revision if project else None
    return reminder


async def _owned_reminder(session, user_id, reminder_id):
    reminder = await session.get(CalendarReminder, reminder_id)
    if reminder is None or reminder.user_id != user_id:
        raise HTTPException(404, "Reminder not found")
    return reminder


async def _lock_reminder(session, reminder):
    try:
        await session.refresh(reminder, with_for_update=True)
    except InvalidRequestError:
        raise HTTPException(404, "Task is no longer available. Refresh the task list.") from None


async def update_reminder(session: AsyncSession, *, user_id, reminder_id, body: CalendarReminderUpdate, expected_project=None):
    reminder = await _owned_reminder(session, user_id, reminder_id)
    original_project = reminder.project_id
    changes = body.model_dump(exclude_unset=True)
    target_id = changes.get("project_id", original_project)
    note_change = "note_ids" in changes or "note_id" in changes
    relation_change = target_id != original_project or (note_change and bool(target_id))
    parents = {}
    for project_id in sorted({value for value in [original_project, target_id] if value}):
        parents[project_id] = await projects.owned_project(session, user_id, project_id, lock=True)
    if expected_project and original_project != expected_project:
        raise HTTPException(404, "Task does not belong to this project")
    if expected_project:
        _revision(parents[expected_project], body.base_revision)
    if relation_change:
        if original_project:
            _revision(parents[original_project], body.base_revision)
        if target_id and target_id != original_project:
            _revision(parents[target_id], body.target_revision if original_project else body.base_revision)
    await _lock_reminder(session, reminder)
    if reminder.project_id != original_project:
        raise HTTPException(409, "Task moved to another project. Refresh before retrying.")
    final_date = changes.get("date", reminder.date)
    final_recurrence = changes.get("recurrence", reminder.recurrence or "once")
    recurrence_changed = final_recurrence != (reminder.recurrence or "once")
    if final_recurrence != "once" and final_date is None:
        raise HTTPException(422, "Recurring reminders require a start date")
    reminder.date = final_date
    reminder.recurrence = final_recurrence
    if "text" in changes:
        reminder.text = body.text
    if recurrence_changed:
        reminder.is_done = False
        reminder.completed_at = None
        await session.execute(delete(CalendarReminderCompletion).where(CalendarReminderCompletion.reminder_id == reminder.id))
    reminder.project_id = target_id
    if "is_done" in changes:
        if final_recurrence == "once":
            if body.is_done != reminder.is_done:
                reminder.is_done = body.is_done
                reminder.completed_at = datetime.now(timezone.utc) if body.is_done else None
        else:
            occurrence = body.occurrence_date or reminder.date
            if not _matches_recurrence(reminder, occurrence):
                raise HTTPException(422, "Date is not an occurrence of this recurring reminder")
            completion = (await session.execute(select(CalendarReminderCompletion).where(
                CalendarReminderCompletion.reminder_id == reminder.id,
                CalendarReminderCompletion.occurrence_date == occurrence))).scalar_one_or_none()
            if body.is_done and completion is None:
                session.add(CalendarReminderCompletion(reminder_id=reminder.id, user_id=user_id, occurrence_date=occurrence))
            elif not body.is_done and completion is not None:
                await session.delete(completion)
    if note_change:
        note_ids = changes.get("note_ids") or [] if "note_ids" in changes else [changes.get("note_id")]
        notes = await _load_notes(session, user_id, note_ids)
        await session.execute(delete(CalendarReminderNote).where(CalendarReminderNote.reminder_id == reminder.id))
        for position, note in enumerate(notes):
            session.add(CalendarReminderNote(reminder_id=reminder.id, note_id=note.id, position=position))
        _set_notes(reminder, notes)
    else:
        await _attach_linked_notes(session, user_id=user_id, reminders=[reminder])
        notes = reminder.linked_notes
    if target_id and relation_change:
        await _join_notes(session, user_id, target_id, notes)
    for project in parents.values():
        clear_next = project.next_reminder_id == reminder.id and (target_id != project.id or reminder.is_done or final_recurrence != "once")
        if clear_next:
            project.next_reminder_id = None
        if relation_change or clear_next:
            projects._advance(project)
    await session.commit()
    await session.refresh(reminder)
    _set_notes(reminder, notes)
    reminder.project_revision = parents[target_id].revision if target_id else None
    return reminder


async def delete_reminder(session, *, user_id, reminder_id, base_revision=None):
    reminder = await _owned_reminder(session, user_id, reminder_id)
    parent_id = reminder.project_id
    parent = await projects.owned_project(session, user_id, parent_id, lock=True) if parent_id else None
    if parent:
        _revision(parent, base_revision)
    await _lock_reminder(session, reminder)
    if reminder.project_id != parent_id:
        raise HTTPException(409, "Task moved. Refresh before deleting.")
    if parent:
        if parent.next_reminder_id == reminder.id:
            parent.next_reminder_id = None
        projects._advance(parent)
    await session.delete(reminder)
    await session.commit()


async def list_reminders(session, *, user_id, start=None, end=None, include_done=True, note_id=None,
                         include_unscheduled=False, unscheduled_only=False, completed_only=False,
                         completion_start=None, completion_end=None, project_id=None, kind=None, limit=None, offset=0, unassigned_only=False):
    filters = [CalendarReminder.user_id == user_id]
    if project_id:
        filters.append(CalendarReminder.project_id == project_id)
    if unassigned_only:
        filters.append(CalendarReminder.project_id.is_(None))
    if unscheduled_only:
        filters.append(CalendarReminder.date.is_(None))
    elif not include_unscheduled:
        filters.append(CalendarReminder.date.is_not(None))
    if kind:
        filters.append(CalendarReminder.recurrence == "once" if kind == "once" else CalendarReminder.recurrence != "once")
    if note_id:
        filters.append(CalendarReminder.id.in_(select(CalendarReminderNote.reminder_id).where(CalendarReminderNote.note_id == note_id)))
    reminders = list((await session.execute(select(CalendarReminder).where(*filters)
        .order_by(CalendarReminder.date.asc().nulls_last(), CalendarReminder.created_at, CalendarReminder.id))).scalars())
    dated = [reminder.date for reminder in reminders if reminder.date]
    range_start = start or min(dated, default=_today_key())
    range_end = end or max([range_start, *dated], default=_today_key())
    if start and end and start > end:
        raise HTTPException(422, "Start date must not be after end date")
    if completion_start and completion_end and completion_start > completion_end:
        raise HTTPException(422, "Completion start date must not be after end date")
    items = []
    completions = set()
    if (start or end) and not unscheduled_only:
        rows = await session.execute(select(CalendarReminderCompletion.reminder_id, CalendarReminderCompletion.occurrence_date)
            .where(CalendarReminderCompletion.user_id == user_id, CalendarReminderCompletion.occurrence_date >= range_start,
                   CalendarReminderCompletion.occurrence_date <= range_end))
        completions = set(rows.all())
    for reminder in reminders:
        if reminder.date is None:
            if completion_start or completion_end:
                completed_day = reminder.completed_at.date().isoformat() if reminder.completed_at else None
                if completed_day is not None and ((completion_start and completed_day < completion_start) or (completion_end and completed_day > completion_end)):
                    continue
            occurrences = [reminder]
        elif start or end:
            if (reminder.recurrence or "once") == "once":
                occurrences = [reminder] if range_start <= reminder.date <= range_end else []
            else:
                occurrences = []
                cursor = max(date.fromisoformat(range_start), date.fromisoformat(reminder.date))
                last = date.fromisoformat(range_end)
                if (last - cursor).days > 3660:
                    raise HTTPException(422, "Recurring reminder ranges are limited to ten years")
                while cursor <= last:
                    day = cursor.isoformat()
                    if _matches_recurrence(reminder, day):
                        clone = CalendarReminder(id=reminder.id, user_id=user_id, date=day, text=reminder.text,
                            recurrence=reminder.recurrence, is_done=(reminder.id, day) in completions,
                            project_id=reminder.project_id, completed_at=None)
                        clone.created_at, clone.updated_at = reminder.created_at, reminder.updated_at
                        occurrences.append(clone)
                    cursor += timedelta(days=1)
        else:
            occurrences = [reminder]
        items.extend(item for item in occurrences if (include_done or not item.is_done) and (not completed_only or item.is_done))
    total = len(items)
    items = items[offset:offset + limit] if limit is not None else items[offset:]
    await _hydrate(session, user_id, items)
    overdue_filters = [CalendarReminder.user_id == user_id, CalendarReminder.is_done.is_(False),
                       CalendarReminder.date < _today_key()]
    if project_id:
        overdue_filters.append(CalendarReminder.project_id == project_id)
    if note_id:
        overdue_filters.append(CalendarReminder.id.in_(select(CalendarReminderNote.reminder_id).where(CalendarReminderNote.note_id == note_id)))
    overdue = (await session.execute(select(func.count()).select_from(CalendarReminder).where(*overdue_filters))).scalar() or 0
    return CalendarReminderList(items=[CalendarReminderRead.model_validate(item) for item in items], total=total, overdue_count=overdue)


async def project_tasks(session, *, user_id, project_id, kind="once", start=None, end=None, include_done=True, limit=30, offset=0):
    project = await projects.owned_project(session, user_id, project_id)
    if kind == "recurring" and (not start or not end):
        raise HTTPException(422, "Choose a date range for recurring reminders")
    listed = await list_reminders(session, user_id=user_id, project_id=project_id, kind=kind,
        include_unscheduled=True, include_done=include_done, start=start if kind == "recurring" else None,
        end=end if kind == "recurring" else None, limit=limit, offset=offset)
    rows = await session.execute(select(CalendarReminder.is_done, func.count()).where(CalendarReminder.user_id == user_id,
        CalendarReminder.project_id == project_id, CalendarReminder.recurrence == "once").group_by(CalendarReminder.is_done))
    counts = dict(rows.all())
    next_task = None
    if project.next_reminder_id:
        reminder = (await session.execute(select(CalendarReminder).where(CalendarReminder.id == project.next_reminder_id,
            CalendarReminder.project_id == project_id, CalendarReminder.user_id == user_id,
            CalendarReminder.recurrence == "once", CalendarReminder.is_done.is_(False)))).scalar_one_or_none()
        if reminder:
            await _hydrate(session, user_id, [reminder])
            next_task = CalendarReminderRead.model_validate(reminder)
    return ProjectTaskList(**listed.model_dump(), pending_count=counts.get(False, 0), completed_count=counts.get(True, 0), next_task=next_task)


async def set_next_task(session, *, user_id, project_id, body):
    project = await projects.owned_project(session, user_id, project_id, lock=True)
    _revision(project, body.base_revision)
    if body.reminder_id:
        task = (await session.execute(select(CalendarReminder).where(CalendarReminder.id == body.reminder_id,
            CalendarReminder.user_id == user_id, CalendarReminder.project_id == project_id).with_for_update())).scalar_one_or_none()
        if task is None:
            raise HTTPException(404, "Task does not belong to this project")
        if task.is_done or task.recurrence != "once":
            raise HTTPException(422, "Next step must be an unfinished one-time task")
    if project.next_reminder_id != body.reminder_id:
        project.next_reminder_id = body.reminder_id
        projects._advance(project)
    await session.commit()
    await session.refresh(project)
    return await projects.get_project(session, user_id=user_id, project_id=project_id)
