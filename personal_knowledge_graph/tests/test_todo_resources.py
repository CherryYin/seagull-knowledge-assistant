from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from pkg.api.calendar_reminders import router as calendar_router
from pkg.api.deps import get_current_user
from pkg.api.projects import router
from pkg.db import get_session
from pkg.schemas.application.project import ProjectNextTask, TodoResourcesAdd
from pkg.schemas.calendar_reminder import CalendarReminderUpdate
from pkg.services.application import projects, reminders, todo_resources
from tests.test_project_tasks import create_task
from tests.test_projects import database as database, make_project


def links(revision, role="context", *refs):
    return TodoResourcesAdd(base_revision=revision, role=role,
        resources=[{"resource_type": kind, "resource_id": resource_id} for kind, resource_id in (refs or [("note", "note-1")])])


def test_resource_roles_and_targets_validate():
    for role, kind in [("result", "source"), ("context", "wiki"), ("context", "chat_session"), ("unknown", "note")]:
        with pytest.raises(ValidationError):
            links(1, role, (kind, "target"))


@pytest.mark.asyncio
async def test_context_result_roles_are_explicit_and_duplicate_add_is_idempotent(database):
    adapter, _session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project, note_ids=["note-1"])
    listed = await todo_resources.list_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id)
    assert listed.total == 0
    context = await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id,
        body=links(2, "context", ("source", "source-1"), ("note", "note-1")))
    assert context.total == 2 and context.revision == 3
    duplicate = await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id,
        body=links(3, "context", ("source", "source-1"), ("note", "note-1")))
    assert duplicate.total == 2 and duplicate.revision == 3
    result = await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id, body=links(3, "result"))
    assert result.total == 3 and result.revision == 4
    summary = await reminders.project_tasks(adapter, user_id="owner", project_id=project.id)
    assert summary.pending_count == 1 and summary.completed_count == 0
    results = await todo_resources.project_results(adapter, user_id="owner", project_id=project.id)
    assert results.total == 1 and results.items[0].resource_type == "note" and not results.items[0].task_done
    current = await projects.get_project(adapter, user_id="owner", project_id=project.id)
    assert current.status == "active" and current.resource_counts == {"note": 1, "source": 1}


@pytest.mark.asyncio
async def test_invalid_ownership_and_stale_revision_are_atomic(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    for owner, revision, refs, status in [
        ("other", 2, [("note", "note-1")], 404),
        ("owner", 1, [("note", "note-1")], 409),
        ("owner", 2, [("note", "note-1"), ("source", "private-source")], 404),
    ]:
        with pytest.raises(HTTPException) as error:
            await todo_resources.add_resources(adapter, user_id=owner, project_id=project.id, reminder_id=task.id, body=links(revision, "context", *refs))
        assert error.value.status_code == status
        session.rollback()
    assert session.execute(text("SELECT count(*) FROM todo_resources")).scalar_one() == 0
    assert session.execute(text("SELECT count(*) FROM project_resources")).scalar_one() == 0
    assert session.execute(text("SELECT revision FROM projects")).scalar_one() == 2
    with pytest.raises(HTTPException) as error:
        await todo_resources.list_resources(adapter, user_id="other", reminder_id=task.id)
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_move_carries_resources_and_clears_only_source_next_step(database):
    adapter, _session = database
    source = await make_project(adapter)
    destination = await make_project(adapter, title="Destination")
    task = await create_task(adapter, source)
    await todo_resources.add_resources(adapter, user_id="owner", project_id=source.id, reminder_id=task.id,
        body=links(2, "result", ("asset", "asset-1")))
    await reminders.set_next_task(adapter, user_id="owner", project_id=source.id,
        body=ProjectNextTask(base_revision=3, reminder_id=task.id))
    await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, expected_project=source.id,
        body=CalendarReminderUpdate(project_id=destination.id, base_revision=4, target_revision=1))
    old = await projects.get_project(adapter, user_id="owner", project_id=source.id)
    new = await projects.get_project(adapter, user_id="owner", project_id=destination.id)
    assert old.next_reminder_id is None and new.next_reminder_id is None
    assert old.resource_counts == new.resource_counts == {"asset": 1}
    assert (await todo_resources.project_results(adapter, user_id="owner", project_id=source.id)).total == 0
    assert (await todo_resources.project_results(adapter, user_id="owner", project_id=destination.id)).total == 1
    await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, expected_project=destination.id,
        body=CalendarReminderUpdate(project_id=None, base_revision=new.revision))
    retained = await todo_resources.list_resources(adapter, user_id="owner", reminder_id=task.id)
    assert retained.total == 1
    current = await projects.get_project(adapter, user_id="owner", project_id=source.id)
    await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
        body=CalendarReminderUpdate(project_id=source.id, base_revision=current.revision))
    assert (await todo_resources.project_results(adapter, user_id="owner", project_id=source.id)).total == 1


@pytest.mark.asyncio
async def test_remove_link_does_not_remove_content_or_project_reference(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    added = await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id, body=links(2))
    removed = await todo_resources.remove_resource(adapter, user_id="owner", project_id=project.id, reminder_id=task.id,
        link_id=added.items[0].id, base_revision=3)
    assert removed.total == 0
    assert session.execute(text("SELECT count(*) FROM notes WHERE id='note-1'")).scalar_one() == 1
    assert (await projects.get_project(adapter, user_id="owner", project_id=project.id)).resource_counts == {"note": 1}


@pytest.mark.asyncio
async def test_archive_read_only_and_recurring_results_rejected(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project, date="2026-10-14", recurrence="weekly")
    with pytest.raises(HTTPException) as error:
        await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id, body=links(2, "result"))
    assert error.value.status_code == 422
    session.rollback()
    added = await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id, body=links(2))
    await projects.archive_project(adapter, user_id="owner", project_id=project.id, base_revision=3)
    assert (await todo_resources.list_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id)).total == 1
    with pytest.raises(HTTPException) as error:
        await todo_resources.remove_resource(adapter, user_id="owner", project_id=project.id, reminder_id=task.id,
            link_id=added.items[0].id, base_revision=4)
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_result_links_prevent_silent_conversion_to_recurring(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id, body=links(2, "result"))
    with pytest.raises(HTTPException) as error:
        await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id,
            body=CalendarReminderUpdate(date="2026-10-14", recurrence="weekly"))
    assert error.value.status_code == 422
    session.rollback()
    assert session.execute(text("SELECT recurrence FROM calendar_reminders")).scalar_one() == "once"


@pytest.mark.asyncio
async def test_project_delete_preserves_task_links_target_delete_cascades(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    await todo_resources.add_resources(adapter, user_id="owner", project_id=project.id, reminder_id=task.id,
        body=links(2, "context", ("source", "source-1"), ("asset", "asset-1")))
    session.execute(text("DELETE FROM projects WHERE id=:id"), {"id": project.id})
    session.commit()
    session.expire_all()
    assert (await todo_resources.list_resources(adapter, user_id="owner", reminder_id=task.id)).total == 2
    session.execute(text("DELETE FROM sources WHERE id='source-1'"))
    session.commit()
    assert (await todo_resources.list_resources(adapter, user_id="owner", reminder_id=task.id)).total == 1
    await reminders.delete_reminder(adapter, user_id="owner", reminder_id=task.id)
    assert session.execute(text("SELECT count(*) FROM todo_resources")).scalar_one() == 0


def test_resource_table_rejects_invalid_role_and_source_result(database):
    _adapter, session = database
    session.execute(text("INSERT INTO calendar_reminders (id,user_id,text,recurrence,is_done) VALUES ('task','owner','Task','once',0)"))
    session.commit()
    for role in ["invalid", "result"]:
        with pytest.raises(IntegrityError):
            session.execute(text("INSERT INTO todo_resources (id,reminder_id,role,resource_type,source_id) VALUES ('bad','task',:role,'source','source-1')"), {"role": role})
        session.rollback()


def test_resource_routes_auth_revision_pagination_and_task_scope(database):
    adapter, session = database
    app = FastAPI()
    app.include_router(router, prefix="/projects")
    app.include_router(calendar_router, prefix="/calendar/reminders")

    async def database_override():
        try:
            yield adapter
        finally:
            session.rollback()

    app.dependency_overrides[get_session] = database_override
    with TestClient(app) as client:
        assert client.get("/projects/missing/task-results").status_code == 401
        assert client.get("/calendar/reminders/missing/resources").status_code == 401
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="owner")
        project = client.post("/projects", json={"title": "Resources", "goal": "Produce a result"}).json()
        path = f"/projects/{project['id']}"
        task = client.post(f"{path}/tasks", json={"text": "Write", "base_revision": 1}).json()
        resource_path = f"{path}/tasks/{task['id']}/resources"
        payload = {"base_revision": 2, "role": "result", "resources": [{"resource_type": "asset", "resource_id": "asset-1"}, {"resource_type": "note", "resource_id": "note-1"}]}
        assert client.post(resource_path, json={**payload, "base_revision": 1}).status_code == 409
        assert client.post(resource_path, json=payload).status_code == 200
        page = client.get(f"{path}/task-results?limit=1&offset=1").json()
        assert page["total"] == 2 and len(page["items"]) == 1 and page["revision"] == 3
        assert client.get(f"/projects/missing/tasks/{task['id']}/resources").status_code == 404
        assert client.get(f"{resource_path}?limit=101").status_code == 422
        assert client.delete(f"{resource_path}/{page['items'][0]['id']}?base_revision=3").status_code == 200
        assert client.delete(f"{path}/tasks/{task['id']}?base_revision=4").status_code == 200
        assert client.get(f"/calendar/reminders/{task['id']}/resources").json()["total"] == 1
        assert client.get(resource_path).status_code == 404
