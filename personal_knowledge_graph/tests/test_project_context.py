from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

from pkg.api.chat_sessions import router as chat_router
from pkg.api.deps import get_current_user
from pkg.api.projects import router
from pkg.db import get_session
from pkg.models.chat_session import ChatSession
from pkg.schemas.application.project import ProjectContextRequest, ProjectContextSessionCreate, ProjectCreate, ProjectResourcesAdd, ProjectUpdate
from pkg.schemas.calendar_reminder import CalendarReminderUpdate
from pkg.services.application import project_context, projects, reminders
from tests.test_project_tasks import create_task
from tests.test_projects import database as database, make_project


def request(revision=1, *, reminder_id=None, fingerprint=None, refs=None):
    return ProjectContextRequest(base_revision=revision, reminder_id=reminder_id,
        expected_fingerprint=fingerprint, resources=[{"resource_type": kind, "resource_id": resource_id} for kind, resource_id in (refs or [])])


async def prepare(adapter, *refs):
    project = await make_project(adapter)
    if refs:
        return (await projects.add_resources(adapter, user_id="owner", project_id=project.id,
            body=ProjectResourcesAdd(base_revision=1, resources=[{"resource_type": kind, "resource_id": resource_id} for kind, resource_id in refs]))).project
    return project


def test_context_request_bounds_and_no_session_transcripts():
    with pytest.raises(ValidationError):
        request(refs=[("note", f"note-{index}") for index in range(21)])
    with pytest.raises(ValidationError):
        request(refs=[("chat_session", "chat_session-1")])
    with pytest.raises(ValidationError):
        request(fingerprint="fake")


@pytest.mark.asyncio
async def test_preview_is_read_only_bounded_and_fingerprint_stable(database):
    adapter, session = database
    project = await prepare(adapter, ("source", "source-1"), ("note", "note-1"), ("asset", "asset-1"))
    session.execute(text("UPDATE notes SET content=:value, abstract=NULL WHERE id='note-1'"), {"value": "N" * 1500})
    session.execute(text("UPDATE sources SET description='Source summary', raw_content='PRIVATE_RAW', file_path='PRIVATE_FILE' WHERE id='source-1'"))
    session.execute(text("UPDATE assets SET brief='Asset brief', draft_content='PRIVATE_DRAFT' WHERE id='asset-1'"))
    session.commit()
    body = request(2, refs=[("source", "source-1"), ("note", "note-1"), ("asset", "asset-1")])
    snapshot = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=body)
    again = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=body)
    assert snapshot.fingerprint == again.fingerprint and snapshot.generated_at <= again.generated_at
    assert len(snapshot.resources[1].summary) == 1000 and snapshot.truncated
    assert snapshot.resources[1].truncated and len(snapshot.context_text) <= 20000
    assert "PRIVATE" not in snapshot.context_text
    assert "Source summary" in snapshot.context_text and "Asset brief" in snapshot.context_text
    assert "entire owned knowledge base" in snapshot.context_text
    assert session.execute(text("SELECT revision FROM projects")).scalar_one() == 2
    assert session.execute(text("SELECT count(*) FROM chat_sessions")).scalar_one() == 1


@pytest.mark.asyncio
async def test_context_total_budget_retains_every_selected_reference(database):
    adapter, session = database
    project = await projects.create_project(adapter, user_id="owner", body=ProjectCreate(title="Long project", goal="G" * 4000, completion_criteria="C" * 4000))
    refs = []
    for index in range(20):
        resource_id = f"note-{index}-" + "i" * 150
        session.execute(text("INSERT INTO notes (id,user_id,title,abstract) VALUES (:id,'owner',:title,:abstract)"), {"id": resource_id, "title": "T" * 200, "abstract": "S" * 1001})
        refs.append(("note", resource_id))
    session.commit()
    project = (await projects.add_resources(adapter, user_id="owner", project_id=project.id,
        body=ProjectResourcesAdd(base_revision=1, resources=[{"resource_type": kind, "resource_id": resource_id} for kind, resource_id in refs]))).project
    snapshot = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2, refs=refs))
    assert snapshot.truncated and len(snapshot.context_text) <= 20000
    assert len(snapshot.resources) == 20
    assert all(resource_id in snapshot.context_text for _kind, resource_id in refs)
    assert all(len(resource.summary) <= 1000 for resource in snapshot.resources)


@pytest.mark.asyncio
async def test_private_unlinked_missing_and_archived_context_are_rejected(database):
    adapter, session = database
    project = await make_project(adapter)
    for user_id, body, status in [("other", request(), 404), ("owner", request(refs=[("note", "note-1")]), 404), ("owner", request(refs=[("source", "private-source")]), 404), ("owner", request(2), 409)]:
        with pytest.raises(HTTPException) as error:
            await project_context.preview(adapter, user_id=user_id, project_id=project.id, body=body)
        assert error.value.status_code == status
        session.rollback()
    await projects.archive_project(adapter, user_id="owner", project_id=project.id, base_revision=1)
    with pytest.raises(HTTPException) as error:
        await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2))
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_changed_target_requires_fresh_confirmation(database):
    adapter, session = database
    project = await prepare(adapter, ("note", "note-1"))
    initial = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2, refs=[("note", "note-1")]))
    session.execute(text("UPDATE notes SET abstract='New evidence' WHERE id='note-1'"))
    session.commit()
    with pytest.raises(HTTPException) as error:
        await project_context.preview(adapter, user_id="owner", project_id=project.id,
            body=request(2, fingerprint=initial.fingerprint, refs=[("note", "note-1")]))
    assert error.value.status_code == 409
    session.rollback()
    fresh = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2, refs=[("note", "note-1")]))
    assert fresh.fingerprint != initial.fingerprint and "New evidence" in fresh.context_text


@pytest.mark.asyncio
async def test_task_changes_invalidate_snapshot_even_without_project_revision_change(database):
    adapter, session = database
    project = await make_project(adapter)
    task = await create_task(adapter, project)
    initial = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2, reminder_id=task.id))
    await reminders.update_reminder(adapter, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(text="Edited globally"))
    assert (await projects.get_project(adapter, user_id="owner", project_id=project.id)).revision == 2
    with pytest.raises(HTTPException) as error:
        await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2, reminder_id=task.id, fingerprint=initial.fingerprint))
    assert error.value.status_code == 409
    session.rollback()


@pytest.mark.asyncio
async def test_context_session_creation_is_atomic_idempotent_and_scope_is_not_a_link(database):
    adapter, session = database
    project = await prepare(adapter, ("note", "note-1"))
    snapshot = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request(2, refs=[("note", "note-1")]))
    body = ProjectContextSessionCreate(**request(2, fingerprint=snapshot.fingerprint, refs=[("note", "note-1")]).model_dump(), session_id="session-project")
    created = await project_context.create_session(adapter, user_id="owner", project_id=project.id, body=body)
    assert created.project_context["project_revision"] == 3 and created.project_context["launch_fingerprint"] == snapshot.fingerprint
    assert created.messages == [] and not created.is_ephemeral
    repeated = await project_context.create_session(adapter, user_id="owner", project_id=project.id, body=body)
    assert repeated.id == created.id
    assert session.execute(text("SELECT count(*) FROM project_resources WHERE chat_session_id='session-project'")).scalar_one() == 1
    assert session.execute(text("SELECT revision FROM projects")).scalar_one() == 3
    with pytest.raises(HTTPException) as error:
        await project_context.update_session_context(adapter, user_id="owner", project_id=project.id, session_id="chat_session-1",
            body=request(3, fingerprint=created.project_context["fingerprint"], refs=[("note", "note-1")]))
    assert error.value.status_code == 404
    session.rollback()
    assert session.get(ChatSession, "chat_session-1").project_context is None


@pytest.mark.asyncio
async def test_confirmation_conflict_creates_neither_session_nor_link(database):
    adapter, session = database
    project = await make_project(adapter)
    snapshot = await project_context.preview(adapter, user_id="owner", project_id=project.id, body=request())
    await projects.update_project(adapter, user_id="owner", project_id=project.id, body=ProjectUpdate(base_revision=1, goal="Changed"))
    with pytest.raises(HTTPException) as error:
        await project_context.create_session(adapter, user_id="owner", project_id=project.id,
            body=ProjectContextSessionCreate(base_revision=1, expected_fingerprint=snapshot.fingerprint, session_id="not-created"))
    assert error.value.status_code == 409
    session.rollback()
    assert session.get(ChatSession, "not-created") is None
    assert session.execute(text("SELECT count(*) FROM project_resources")).scalar_one() == 0


def test_context_routes_auth_confirmation_and_persisted_history(database):
    adapter, session = database
    app = FastAPI()
    app.include_router(router, prefix="/projects")
    app.include_router(chat_router, prefix="/chat-sessions")

    async def database_override():
        try:
            yield adapter
        finally:
            session.rollback()

    app.dependency_overrides[get_session] = database_override
    with TestClient(app) as client:
        assert client.post("/projects/missing/context-preview", json={"base_revision": 1}).status_code == 401
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="owner")
        project = client.post("/projects", json={"title": "Work", "goal": "Understand"}).json()
        path = f"/projects/{project['id']}"
        preview = client.post(f"{path}/context-preview", json={"base_revision": 1}).json()
        payload = {"base_revision": 1, "expected_fingerprint": preview["fingerprint"], "session_id": "work-session"}
        created = client.post(f"{path}/context-session", json=payload)
        assert created.status_code == 201
        assert client.post(f"{path}/context-session", json=payload).json()["id"] == "work-session"
        snapshot = created.json()["project_context"]
        assert snapshot["project_revision"] == 2
        message = {"id": "message", "role": "user", "content": "Question", "created_at": "2026-10-14T10:00:00Z", "metadata": {"project_context": snapshot}}
        assert client.patch("/chat-sessions/work-session", json={"messages": [message]}).status_code == 200
        stored = client.get("/chat-sessions/work-session").json()
        assert stored["project_context"] == snapshot and stored["messages"][0]["metadata"]["project_context"] == snapshot
        assert client.put(f"{path}/context-session/work-session", json={"base_revision": 2}).status_code == 422
        fresh = client.post(f"{path}/context-preview", json={"base_revision": 2}).json()
        assert client.put(f"{path}/context-session/work-session", json={"base_revision": 2, "expected_fingerprint": fresh["fingerprint"]}).status_code == 200
        assert client.get("/chat-sessions/work-session").json()["messages"][0]["metadata"]["project_context"] == snapshot
