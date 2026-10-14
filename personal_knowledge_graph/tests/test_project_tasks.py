from datetime import datetime, timezone

import pytest
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

from pkg.api.deps import get_current_user
from pkg.api.calendar_reminders import router as calendar_router
from pkg.api.projects import router as project_router
from pkg.db import get_session

from pkg.schemas.application.project import ProjectNextTask
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderUpdate
from pkg.services.application import projects, reminders
from tests.test_projects import database as database, make_project


async def create_task(adapter, project=None, **fields):
    return await reminders.create_reminder(adapter, user_id="owner", body=CalendarReminderCreate(
        text="Review the material", project_id=project.id if project else None,
        base_revision=project.revision if project else None, **fields))


def test_task_dates_are_real_and_recurring_tasks_cannot_be_unscheduled():
    for body in [{"date": "2026-02-30"}, {"date": "2026-1-01"}, {"text": " "}, {"recurrence": "weekly"}]:
        with pytest.raises(ValidationError):
            CalendarReminderCreate(**{"text": "Task", **body})
    assert CalendarReminderCreate(text="Task").date is None
    assert CalendarReminderUpdate(date=None).model_dump(exclude_unset=True) == {"date": None}
    assert "date" not in CalendarReminderUpdate(text="Changed").model_dump(exclude_unset=True)


@pytest.mark.asyncio
async def test_default_calendar_excludes_unscheduled_and_opt_in_ignores_date_range(database):
    adapter, _session = database
    task = await create_task(adapter)
    await create_task(adapter, date="2026-10-13")
    assert (await reminders.list_reminders(adapter, user_id="owner")).total == 1
    listed = await reminders.list_reminders(adapter, user_id="owner", start="2026-10-14", end="2026-10-15", include_unscheduled=True)
    assert listed.total == 1 and listed.items[0].id == task.id and listed.items[0].date is None
    assert (await reminders.list_reminders(adapter, user_id="owner", unscheduled_only=True)).total == 1


@pytest.mark.asyncio
async def test_next_step_completion_from_calendar_syncs_project_and_reopen(database):
    adapter, _session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project, date="2026-10-13")
    await reminders.set_next_task(adapter, user_id="owner", project_id=project.id,
        body=ProjectNextTask(base_revision=2, reminder_id=task.id))
    completed = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=True))
    assert completed.completed_at is not None
    current = await projects.get_project(adapter, user_id="owner", project_id=project.id)
    assert current.next_reminder_id is None and current.status == "active" and current.revision == 4
    overview = await reminders.project_tasks(adapter, user_id="owner", project_id=project.id)
    assert overview.pending_count == 0 and overview.completed_count == 1 and overview.next_task is None
    reopened = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=False))
    assert reopened.completed_at is None and not reopened.is_done


@pytest.mark.asyncio
async def test_scheduling_and_recurrence_changes_validate_combined_state(database):
    adapter, session = database
    task = await create_task(adapter)
    with pytest.raises(HTTPException) as error:
        await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(recurrence="weekly"))
    assert error.value.status_code == 422
    session.rollback()
    changed = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
        body=CalendarReminderUpdate(date="2026-10-13", recurrence="weekly"))
    assert changed.date == "2026-10-13"
    with pytest.raises(HTTPException):
        await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(date=None))
    session.rollback()
    changed = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
        body=CalendarReminderUpdate(date=None, recurrence="once"))
    assert changed.date is None


@pytest.mark.asyncio
async def test_project_task_counts_are_not_limited_by_pagination(database):
    adapter, _session = database
    project = await make_project(adapter)
    for index in range(23):
        current = await projects.get_project(adapter, user_id="owner", project_id=project.id)
        await create_task(adapter, current, date="2026-10-13" if index % 2 else None)
    page = await reminders.project_tasks(adapter, user_id="owner", project_id=project.id, limit=20, offset=20)
    assert page.total == 23 and len(page.items) == 3 and page.pending_count == 23


@pytest.mark.asyncio
async def test_detaching_task_preserves_notes_content_and_global_unscheduled_entry(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project, note_ids=["note-1"])
    assert (await projects.get_project(adapter, user_id="owner", project_id=project.id)).resource_counts == {"note": 1}
    await reminders.set_next_task(adapter, user_id="owner", project_id=project.id, body=ProjectNextTask(base_revision=2, reminder_id=task.id))
    detached = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
        body=CalendarReminderUpdate(project_id=None, base_revision=3), expected_project=project.id)
    assert detached.project_id is None and detached.note_ids == ["note-1"]
    assert (await projects.get_project(adapter, user_id="owner", project_id=project.id)).next_reminder_id is None
    assert session.execute(text("SELECT count(*) FROM notes WHERE id='note-1'")).scalar_one() == 1
    assert (await reminders.list_reminders(adapter, user_id="owner", unscheduled_only=True)).total == 1


@pytest.mark.asyncio
async def test_moving_requires_both_revisions_and_preserves_note_links(database):
    adapter, session = database
    first, second = await make_project(adapter), await make_project(adapter)
    task = await create_task(adapter, first, note_ids=["note-1"])
    with pytest.raises(HTTPException) as error:
        await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
            body=CalendarReminderUpdate(project_id=second.id, base_revision=2, target_revision=99))
    assert error.value.status_code == 409
    session.rollback()
    moved = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
        body=CalendarReminderUpdate(project_id=second.id, base_revision=2, target_revision=1))
    assert moved.project_id == second.id and moved.note_ids == ["note-1"]
    assert (await projects.get_project(adapter, user_id="owner", project_id=second.id)).resource_counts == {"note": 1}


@pytest.mark.asyncio
async def test_foreign_project_and_task_cannot_be_used_as_next_step(database):
    adapter, session = database
    project = await make_project(adapter)
    other = await make_project(adapter, owner="other")
    with pytest.raises(HTTPException) as error:
        await create_task(adapter, other)
    assert error.value.status_code == 404
    session.rollback()
    task = await create_task(adapter)
    with pytest.raises(HTTPException) as error:
        await reminders.set_next_task(adapter, user_id="owner", project_id=project.id, body=ProjectNextTask(base_revision=1, reminder_id=task.id))
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_archived_project_is_read_only_but_calendar_completion_still_works(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    archived = await projects.archive_project(adapter, user_id="owner", project_id=project.id, base_revision=2)
    with pytest.raises(HTTPException) as error:
        await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
            body=CalendarReminderUpdate(is_done=True, base_revision=archived.revision), expected_project=project.id)
    assert error.value.status_code == 409
    session.rollback()
    completed = await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=True))
    assert completed.is_done


@pytest.mark.asyncio
async def test_recurring_completion_only_affects_the_requested_occurrence(database):
    adapter, _session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project, date="2026-10-13", recurrence="weekly")
    await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
        body=CalendarReminderUpdate(is_done=True, occurrence_date="2026-10-20"))
    items = await reminders.project_tasks(adapter, user_id="owner", project_id=project.id, kind="recurring", start="2026-10-13", end="2026-10-27")
    assert [(item.date, item.is_done) for item in items.items] == [("2026-10-13", False), ("2026-10-20", True), ("2026-10-27", False)]
    assert items.pending_count == 0 and items.completed_count == 0
    with pytest.raises(HTTPException):
        await reminders.set_next_task(adapter, user_id="owner", project_id=project.id, body=ProjectNextTask(base_revision=2, reminder_id=task.id))


@pytest.mark.asyncio
async def test_legacy_unknown_completion_times_are_not_invented(database):
    adapter, session = database
    unknown = await create_task(adapter)
    session.execute(text("UPDATE calendar_reminders SET is_done=1, completed_at=NULL WHERE id=:id"), {"id": unknown.id})
    session.commit()
    session.expire_all()
    known = await create_task(adapter)
    await reminders.update_reminder(adapter, user_id="owner", reminder_id=known.id, body=CalendarReminderUpdate(is_done=True))
    listed = await reminders.list_reminders(adapter, user_id="owner", unscheduled_only=True, completed_only=True,
        completion_start="2000-01-01", completion_end="2000-01-02")
    assert listed.total == 1 and listed.items[0].id == unknown.id and listed.items[0].completed_at is None
    assert datetime.now(timezone.utc).year > 2000


@pytest.mark.asyncio
async def test_project_deletion_keeps_tasks_and_reminder_deletion_clears_next(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    await reminders.set_next_task(adapter, user_id="owner", project_id=project.id, body=ProjectNextTask(base_revision=2, reminder_id=task.id))
    await reminders.delete_reminder(adapter, user_id="owner", reminder_id=task.id, base_revision=3)
    assert (await projects.get_project(adapter, user_id="owner", project_id=project.id)).next_reminder_id is None
    current = await projects.get_project(adapter, user_id="owner", project_id=project.id)
    retained = await create_task(adapter, current)
    session.execute(text("DELETE FROM projects WHERE id=:id"), {"id": project.id})
    session.commit()
    session.expire_all()
    listed = await reminders.list_reminders(adapter, user_id="owner", unscheduled_only=True)
    assert listed.items[0].id == retained.id and listed.items[0].project_id is None


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["update", "delete"])
async def test_concurrent_task_deletion_returns_recoverable_not_found(database, action):
    adapter, session = database
    task = await create_task(adapter)

    async def deleted_after_read(model, record_id):
        record = session.get(model, record_id)
        session.execute(text("DELETE FROM calendar_reminders WHERE id=:id"), {"id": record_id})
        session.commit()
        return record

    adapter.get.side_effect = deleted_after_read
    with pytest.raises(HTTPException) as error:
        if action == "update":
            await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=True))
        else:
            await reminders.delete_reminder(adapter, user_id="owner", reminder_id=task.id)
    assert error.value.status_code == 404


def test_project_task_routes_enforce_revision_scope_and_real_dates(database):
    adapter, session = database
    app = FastAPI()
    app.include_router(project_router, prefix="/projects")
    app.include_router(calendar_router, prefix="/calendar/reminders")

    async def database_override():
        try:
            yield adapter
        finally:
            session.rollback()

    app.dependency_overrides[get_session] = database_override
    with TestClient(app) as client:
        assert client.get("/projects/missing/tasks").status_code == 401
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="owner")
        project = client.post("/projects", json={"title": "Actions", "goal": "Keep working"}).json()
        path = f"/projects/{project['id']}"
        assert client.post(f"{path}/tasks", json={"text": "Task"}).status_code == 422
        assert client.post(f"{path}/tasks", json={"text": "Task", "date": "2026-02-30", "base_revision": 1}).status_code == 422
        created = client.post(f"{path}/tasks", json={"text": "Task", "base_revision": 1})
        assert created.status_code == 201 and created.json()["date"] is None
        task = created.json()
        assert client.get("/calendar/reminders").json()["total"] == 0
        assert client.get("/calendar/reminders?unscheduled_only=true").json()["total"] == 1
        assert client.patch(f"{path}/next-task", json={"base_revision": 1, "reminder_id": task["id"]}).status_code == 409
        assert client.patch(f"{path}/next-task", json={"base_revision": 2, "reminder_id": task["id"]}).status_code == 200
        assert client.patch(f"/calendar/reminders/{task['id']}", json={"is_done": True}).status_code == 200
        summary = client.get(f"{path}/tasks?limit=1").json()
        assert summary["completed_count"] == 1 and summary["next_task"] is None
        assert client.get(f"{path}/tasks?kind=recurring").status_code == 422
        assert client.get("/calendar/reminders?start=2026-02-30").status_code == 422
        assert client.get("/calendar/reminders?completion_start=2026-10-20&completion_end=2026-10-13").status_code == 422
