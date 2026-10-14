from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

from pkg.api.deps import get_current_user
from pkg.api.projects import router
from pkg.db import get_session
from pkg.schemas.application.project import ProjectSavedResultLink, ProjectUpdate
from pkg.services.application import project_results, projects, todo_resources
from tests.test_project_tasks import create_task
from tests.test_projects import database as database, make_project


def body(revision, task_id=None, kind="note", resource_id=None):
    return ProjectSavedResultLink(base_revision=revision, reminder_id=task_id,
        resource_type=kind, resource_id=resource_id or f"{kind}-1")


def test_only_saved_output_types_and_supported_task_results_are_allowed():
    for fields in [{"resource_type": "source"}, {"resource_type": "chat_session"},
                   {"resource_type": "wiki", "reminder_id": "task"}, {"resource_id": ""}]:
        with pytest.raises(ValidationError):
            ProjectSavedResultLink(**{"base_revision": 1, "resource_type": "note", "resource_id": "note-1", **fields})


@pytest.mark.asyncio
async def test_saved_result_links_are_atomic_retry_safe_and_do_not_complete_work(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    request = body(2, task.id)
    result = await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=request)
    assert result.project.revision == 3 and result.reminder_id == task.id
    await projects.update_project(adapter, user_id="owner", project_id=project.id,
        body=ProjectUpdate(base_revision=3, goal="New goal"))
    retried = await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=request)
    assert retried.project.revision == 4 and retried.project.status == "active"
    assert session.execute(text("SELECT count(*) FROM project_resources")).scalar_one() == 1
    assert session.execute(text("SELECT count(*) FROM todo_resources")).scalar_one() == 1
    assert session.execute(text("SELECT is_done FROM calendar_reminders")).scalar_one() == 0
    assert session.execute(text("SELECT count(*) FROM notes")).scalar_one() == 1
    results = await todo_resources.project_results(adapter, user_id="owner", project_id=project.id)
    assert results.total == 1 and not results.items[0].task_done


@pytest.mark.asyncio
async def test_partial_previous_link_requires_current_revision_then_adds_task_without_copy(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=body(2))
    with pytest.raises(HTTPException) as error:
        await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=body(2, task.id))
    assert error.value.status_code == 409
    session.rollback()
    linked = await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=body(3, task.id))
    assert linked.project.revision == 4
    assert session.execute(text("SELECT count(*) FROM project_resources")).scalar_one() == 1
    assert session.execute(text("SELECT count(*) FROM todo_resources")).scalar_one() == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("case,status", [("foreign_project", 404), ("foreign_target", 404), ("missing_target", 404),
    ("wrong_task", 404), ("recurring_task", 422), ("archived", 409), ("stale", 409)])
async def test_invalid_destinations_do_not_leave_partial_links(database, case, status):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    revision = 2
    resource_id = "note-1"
    owner = "other" if case == "foreign_project" else "owner"
    if case == "foreign_target":
        session.execute(text("UPDATE notes SET user_id='other' WHERE id='note-1'"))
    if case == "missing_target":
        resource_id = "missing"
    if case == "wrong_task":
        session.execute(text("UPDATE calendar_reminders SET project_id=NULL WHERE id=:id"), {"id": task.id})
    if case == "recurring_task":
        session.execute(text("UPDATE calendar_reminders SET recurrence='daily', date='2026-10-14' WHERE id=:id"), {"id": task.id})
    if case == "archived":
        await projects.archive_project(adapter, user_id="owner", project_id=project.id, base_revision=2)
    if case == "stale":
        revision = 1
    session.commit()
    session.expire_all()
    with pytest.raises(HTTPException) as error:
        await project_results.link_saved_result(adapter, user_id=owner, project_id=project.id,
            body=body(revision, task.id, resource_id=resource_id))
    assert error.value.status_code == status
    session.rollback()
    assert session.execute(text("SELECT count(*) FROM project_resources")).scalar_one() == 0
    assert session.execute(text("SELECT count(*) FROM todo_resources")).scalar_one() == 0


@pytest.mark.asyncio
async def test_archived_retry_and_moved_task_revalidate_membership(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    request = body(2, task.id)
    await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=request)
    session.execute(text("UPDATE calendar_reminders SET project_id=NULL WHERE id=:id"), {"id": task.id})
    session.commit()
    session.expire_all()
    with pytest.raises(HTTPException) as error:
        await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=request)
    assert error.value.status_code == 404
    session.rollback()
    await projects.archive_project(adapter, user_id="owner", project_id=project.id, base_revision=3)
    with pytest.raises(HTTPException) as error:
        await project_results.link_saved_result(adapter, user_id="owner", project_id=project.id, body=body(2))
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_saved_wiki_links_project_only_and_api_preserves_auth_contract(database):
    adapter, _session = database
    project = await make_project(adapter)
    app = FastAPI()
    app.include_router(router, prefix="/projects")
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="owner")

    async def session_override():
        yield adapter

    app.dependency_overrides[get_session] = session_override
    with TestClient(app) as client:
        request = body(1, kind="wiki").model_dump()
        response = client.post(f"/projects/{project.id}/saved-result", json=request)
        assert response.status_code == 200 and response.json()["project"]["resource_counts"] == {"wiki": 1}
        assert client.post(f"/projects/{project.id}/saved-result", json=request).json()["project"]["revision"] == 2
        assert client.post(f"/projects/{project.id}/saved-result", json={**request, "reminder_id": "task"}).status_code == 422
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="other")
        assert client.post(f"/projects/{project.id}/saved-result", json=request).status_code == 404
