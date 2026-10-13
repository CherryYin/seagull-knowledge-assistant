from types import SimpleNamespace
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event, insert, inspect, text
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from pkg.api.deps import get_current_user
from pkg.api.projects import router
from pkg.db import get_session
from pkg.models.application.project import Project, ProjectResource
from pkg.models.user import User
from pkg.schemas.application.project import ProjectCreate, ProjectResourcesAdd, ProjectUpdate
from pkg.services.application import projects


@pytest.fixture
def database():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    with engine.begin() as connection:
        models = [User, *projects.TARGET_MODELS.values()]
        for model in models:
            columns = ", ".join(f'"{column.name}" TEXT' + (" PRIMARY KEY" if column.primary_key else "")
                                for column in model.__table__.columns)
            connection.execute(text(f'CREATE TABLE "{model.__tablename__}" ({columns})'))
        connection.execute(text("INSERT INTO users (id) VALUES ('owner'), ('other')"))
        connection.execute(text("INSERT INTO sources (id, user_id, title, source_type) VALUES "
            "('source-1', 'owner', 'Paper', 'article'), ('private-source', 'other', 'Private', 'article')"))
        for kind, table in [("note", "notes"), ("wiki", "wiki_pages"), ("asset", "assets"), ("chat_session", "chat_sessions")]:
            connection.execute(text(f"INSERT INTO {table} (id, user_id, title) VALUES (:id, 'owner', :title)"),
                               {"id": f"{kind}-1", "title": f"Saved {kind}"})
    Project.__table__.create(engine)
    ProjectResource.__table__.create(engine)
    session = Session(engine, expire_on_commit=False)

    async def execute(statement):
        return session.execute(statement)

    async def commit():
        session.commit()

    async def refresh(record):
        session.refresh(record)

    async def delete(record):
        session.delete(record)

    adapter = SimpleNamespace(execute=AsyncMock(side_effect=execute), commit=AsyncMock(side_effect=commit),
                              refresh=AsyncMock(side_effect=refresh), delete=AsyncMock(side_effect=delete),
                              add=session.add)
    try:
        yield adapter, session
    finally:
        session.close()
        engine.dispose()


async def make_project(adapter, *, owner="owner", title="Memory selection"):
    return await projects.create_project(adapter, user_id=owner,
        body=ProjectCreate(title=title, goal="Choose a useful implementation"))


def resources(revision, *refs):
    return ProjectResourcesAdd(base_revision=revision,
        resources=[{"resource_type": kind, "resource_id": target} for kind, target in refs])


def test_project_input_validation_preserves_explicit_empty_criteria_and_rejects_null():
    assert ProjectCreate(title=" Project ", goal=" Goal ").title == "Project"
    assert ProjectUpdate(base_revision=1, completion_criteria=" ").completion_criteria == ""
    for body in [{"title": " "}, {"goal": None}, {"status": None}]:
        with pytest.raises(ValidationError):
            ProjectUpdate(base_revision=1, **body)
    with pytest.raises(ValidationError):
        resources(1, ("unknown", "id"))
    with pytest.raises(ValidationError):
        ProjectResourcesAdd(base_revision=1, resources=[])


@pytest.mark.asyncio
async def test_project_lifecycle_preserves_completion_when_archiving(database):
    adapter, _session = database
    project = await make_project(adapter)
    completed = await projects.update_project(adapter, user_id="owner", project_id=project.id,
        body=ProjectUpdate(base_revision=1, status="completed"))
    assert completed.revision == 2 and completed.completed_at is not None
    archived = await projects.archive_project(adapter, user_id="owner", project_id=project.id, base_revision=2)
    assert archived.status == "completed" and archived.archived_at is not None
    restored = await projects.archive_project(adapter, user_id="owner", project_id=project.id,
                                              base_revision=3, restore=True)
    reopened = await projects.update_project(adapter, user_id="owner", project_id=project.id,
        body=ProjectUpdate(base_revision=restored.revision, status="active"))
    assert reopened.completed_at is None and reopened.archived_at is None


@pytest.mark.asyncio
async def test_conflicts_and_archived_writes_do_not_change_project(database):
    adapter, session = database
    project = await make_project(adapter)
    updated = await projects.update_project(adapter, user_id="owner", project_id=project.id,
        body=ProjectUpdate(base_revision=1, title="New title"))
    with pytest.raises(HTTPException) as conflict:
        await projects.update_project(adapter, user_id="owner", project_id=project.id,
            body=ProjectUpdate(base_revision=1, title="Lost update"))
    assert conflict.value.status_code == 409
    session.rollback()
    assert (await projects.get_project(adapter, user_id="owner", project_id=project.id)).title == "New title"
    archived = await projects.archive_project(adapter, user_id="owner", project_id=project.id,
                                              base_revision=updated.revision)
    with pytest.raises(HTTPException) as error:
        await projects.add_resources(adapter, user_id="owner", project_id=project.id,
                                     body=resources(archived.revision, ("source", "source-1")))
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_project_and_resource_ownership_are_independently_enforced(database):
    adapter, session = database
    project = await make_project(adapter, owner="other")
    with pytest.raises(HTTPException) as error:
        await projects.get_project(adapter, user_id="owner", project_id=project.id)
    assert error.value.status_code == 404
    own = await make_project(adapter)
    with pytest.raises(HTTPException) as error:
        await projects.add_resources(adapter, user_id="owner", project_id=own.id,
            body=resources(1, ("source", "source-1"), ("source", "private-source")))
    assert error.value.status_code == 404
    session.rollback()
    result = await projects.list_resources(adapter, user_id="owner", project_id=own.id)
    assert result.total == 0 and result.revision == 1


@pytest.mark.asyncio
async def test_all_resource_kinds_share_references_without_copying_or_duplicate_links(database):
    adapter, _session = database
    first = await make_project(adapter)
    second = await make_project(adapter)
    refs = [(kind, "source-1" if kind == "source" else f"{kind}-1") for kind in projects.TARGET_MODELS]
    result = await projects.add_resources(adapter, user_id="owner", project_id=first.id, body=resources(1, *refs, refs[0]))
    assert result.added == 5 and result.project.revision == 2
    repeated = await projects.add_resources(adapter, user_id="owner", project_id=first.id, body=resources(2, *refs))
    assert repeated.added == 0 and repeated.project.revision == 2
    await projects.add_resources(adapter, user_id="owner", project_id=second.id, body=resources(1, refs[0]))
    reverse = await projects.projects_for_resource(adapter, user_id="owner", resource_type="source", resource_id="source-1")
    assert reverse.total == 2
    listed = await projects.list_resources(adapter, user_id="owner", project_id=first.id, limit=2)
    assert listed.total == 5 and len(listed.items) == 2
    assert sum(result.project.resource_counts.values()) == 5
    session_links = await projects.list_resources(adapter, user_id="owner", project_id=first.id, resource_type="chat_session")
    assert session_links.items[0].href == "/chat?session=chat_session-1"


@pytest.mark.asyncio
async def test_removing_link_never_deletes_target_or_other_projects_link(database):
    adapter, session = database
    first = await make_project(adapter)
    second = await make_project(adapter)
    for project in [first, second]:
        await projects.add_resources(adapter, user_id="owner", project_id=project.id, body=resources(1, ("source", "source-1")))
    links = await projects.list_resources(adapter, user_id="owner", project_id=first.id)
    await projects.remove_resource(adapter, user_id="owner", project_id=first.id, link_id=links.items[0].id, base_revision=2)
    assert session.execute(text("SELECT count(*) FROM sources WHERE id='source-1'")).scalar_one() == 1
    assert (await projects.list_resources(adapter, user_id="owner", project_id=second.id)).total == 1


@pytest.mark.asyncio
async def test_target_deletion_only_cascades_links(database):
    adapter, session = database
    project = await make_project(adapter)
    await projects.add_resources(adapter, user_id="owner", project_id=project.id, body=resources(1, ("source", "source-1")))
    session.execute(text("DELETE FROM sources WHERE id='source-1'"))
    session.commit()
    result = await projects.get_project(adapter, user_id="owner", project_id=project.id)
    assert result.resource_counts == {}
    assert (await projects.list_resources(adapter, user_id="owner", project_id=project.id)).total == 0


@pytest.mark.asyncio
async def test_lists_and_options_filter_owned_records_with_full_totals(database):
    adapter, _session = database
    await make_project(adapter)
    second = await make_project(adapter, title="Another project")
    await make_project(adapter, owner="other")
    listed = await projects.list_projects(adapter, user_id="owner", limit=1)
    assert listed.total == 2 and len(listed.items) == 1
    await projects.archive_project(adapter, user_id="owner", project_id=second.id, base_revision=1)
    assert (await projects.list_projects(adapter, user_id="owner")).total == 1
    assert (await projects.list_projects(adapter, user_id="owner", archived=True)).total == 1
    options = await projects.resource_options(adapter, user_id="owner", resource_type="source", query="Paper")
    assert options.total == 1 and options.items[0].resource_id == "source-1"
    assert (await projects.resource_options(adapter, user_id="owner", resource_type="source", query="%" )).total == 0


@pytest.mark.asyncio
async def test_mutation_locks_project_row_and_scopes_sql_to_owner(database):
    adapter, _session = database
    project = await make_project(adapter)
    await projects.update_project(adapter, user_id="owner", project_id=project.id,
                                  body=ProjectUpdate(base_revision=1, goal="Updated goal"))
    statements = [str(call.args[0].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
                  for call in adapter.execute.await_args_list]
    assert any("FOR UPDATE" in sql and "projects.user_id = 'owner'" in sql for sql in statements)


@pytest.mark.asyncio
async def test_resource_previews_never_fetch_original_bodies(database):
    adapter, _session = database
    for kind in projects.TARGET_MODELS:
        await projects.resource_options(adapter, user_id="owner", resource_type=kind)
    statements = [str(call.args[0].compile(dialect=postgresql.dialect())) for call in adapter.execute.await_args_list]
    for statement in statements:
        assert "raw_content" not in statement
        assert "body_md" not in statement
        assert "chat_sessions.messages" not in statement


def test_database_constraints_prevent_mismatched_targets_and_missing_foreign_keys(database):
    _adapter, session = database
    project = Project(user_id="owner", title="Test", goal="Test")
    session.add(project)
    session.commit()
    for values in [{"resource_type": "note", "source_id": "source-1"},
                   {"resource_type": "source", "source_id": "source-1", "note_id": "note-1"},
                   {"resource_type": "source", "source_id": "missing"}]:
        with pytest.raises(IntegrityError):
            session.execute(insert(ProjectResource).values(project_id=project.id, **values))
            session.commit()
        session.rollback()


def test_authenticated_routes_validate_inputs_and_preserve_static_route_order(database):
    adapter, session = database
    app = FastAPI()
    app.include_router(router, prefix="/projects")

    async def database_override():
        try:
            yield adapter
        finally:
            session.rollback()

    app.dependency_overrides[get_session] = database_override
    with TestClient(app) as client:
        assert client.get("/projects").status_code == 401
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="owner")
        assert client.post("/projects", json={"title": " ", "goal": "Goal"}).status_code == 422
        assert client.get("/projects?limit=0").status_code == 422
        assert client.get("/projects/resource-options?resource_type=unknown").status_code == 422
        assert client.get("/projects/resource-options?resource_type=source").json()["total"] == 1
        created = client.post("/projects", json={"title": "Project", "goal": "Goal"})
        assert created.status_code == 201
        project = created.json()
        added = client.post(f"/projects/{project['id']}/resources", json=resources(1, ("source", "source-1")).model_dump())
        assert added.status_code == 200 and added.json()["added"] == 1
        assert client.patch(f"/projects/{project['id']}", json={"base_revision": 1, "title": "Changed"}).status_code == 409
        assert client.get("/projects/for-resource?resource_type=source&resource_id=source-1").json()["total"] == 1


@pytest.mark.asyncio
async def test_stale_resource_mutations_and_wrong_project_removal_leave_links_intact(database):
    adapter, session = database
    first = await make_project(adapter)
    second = await make_project(adapter)
    await projects.add_resources(adapter, user_id="owner", project_id=first.id, body=resources(1, ("source", "source-1")))
    link = (await projects.list_resources(adapter, user_id="owner", project_id=first.id)).items[0]
    for project_id, revision, expected in [(first.id, 1, 409), (second.id, 1, 404)]:
        with pytest.raises(HTTPException) as error:
            await projects.remove_resource(adapter, user_id="owner", project_id=project_id, link_id=link.id, base_revision=revision)
        assert error.value.status_code == expected
        session.rollback()
    with pytest.raises(HTTPException) as error:
        await projects.projects_for_resource(adapter, user_id="owner", resource_type="source", resource_id="private-source")
    assert error.value.status_code == 404
    assert (await projects.list_resources(adapter, user_id="owner", project_id=first.id)).total == 1


def test_migration_roundtrip_matches_model_constraints_and_preserves_targets(database):
    _adapter, session = database
    engine = session.get_bind()
    ProjectResource.__table__.drop(engine)
    Project.__table__.drop(engine)
    path = Path(__file__).parents[1] / "alembic/versions/f6a7b8c9d0e2_add_projects.py"
    spec = spec_from_file_location("project_migration", path)
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        inspector = inspect(connection)
        for model in [Project, ProjectResource]:
            assert {column["name"] for column in inspector.get_columns(model.__tablename__)} == set(model.__table__.columns.keys())
            assert {entry["name"] for entry in inspector.get_check_constraints(model.__tablename__)} == {
                constraint.name for constraint in model.__table__.constraints if constraint.__class__.__name__ == "CheckConstraint"}
            assert {entry["name"] for entry in inspector.get_indexes(model.__tablename__)} == {index.name for index in model.__table__.indexes}
        assert len(inspector.get_foreign_keys("project_resources")) == 6
        assert len(inspector.get_unique_constraints("project_resources")) == 5
        migration.downgrade()
        assert "projects" not in inspect(connection).get_table_names()
        assert connection.execute(text("SELECT count(*) FROM sources")).scalar_one() == 2
