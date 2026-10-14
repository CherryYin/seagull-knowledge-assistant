import asyncio
import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from pkg.config import settings
from pkg.schemas.application.project import ProjectContextRequest, ProjectContextSessionCreate, ProjectCreate
from pkg.services.application import project_context, projects
from tests.test_project_tasks_postgres import migration


@pytest.mark.skipif(os.environ.get("SEAGULL_PROJECT_POSTGRES_TEST") != "1", reason="Requires explicit PostgreSQL test opt-in")
@pytest.mark.asyncio
async def test_context_migration_and_atomic_idempotent_concurrent_session_creation():
    schema = f"project_context_test_{uuid.uuid4().hex}"
    admin = create_async_engine(settings.DATABASE_URL)
    engine = create_async_engine(settings.DATABASE_URL, connect_args={"server_settings": {"search_path": schema}})
    created = False
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        async with engine.begin() as connection:
            await connection.execute(text("CREATE TABLE users (id VARCHAR PRIMARY KEY)"))
            for model in projects.TARGET_MODELS.values():
                columns = ", ".join(f'"{column.name}" {column.type.compile(dialect=engine.dialect)}' + (" PRIMARY KEY" if column.primary_key else "")
                    for column in model.__table__.columns if column.name != "project_context")
                await connection.execute(text(f'CREATE TABLE "{model.__tablename__}" ({columns})'))
            await connection.execute(text("CREATE TABLE calendar_reminders (id VARCHAR PRIMARY KEY, user_id VARCHAR NOT NULL, date VARCHAR(10) NOT NULL, text TEXT NOT NULL, note_id VARCHAR, recurrence VARCHAR(20) NOT NULL DEFAULT 'once', is_done BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"))
            await connection.execute(text("INSERT INTO users (id) VALUES ('owner')"))
            await connection.execute(text("INSERT INTO chat_sessions (id,user_id,title,messages) VALUES ('legacy','owner','History','[]')"))
            for name in ["f6a7b8c9d0e2_add_projects.py", "a7b8c9d0e3f4_project_tasks.py", "b8c9d0e1f2a3_todo_resources.py", "c9d0e1f2a3b4_project_chat_context.py"]:
                await connection.run_sync(lambda sync, name=name: migration(name, sync).upgrade())
            assert (await connection.execute(text("SELECT project_context FROM chat_sessions WHERE id='legacy'"))).scalar_one() is None
        async with AsyncSession(engine, expire_on_commit=False) as session:
            project = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="Work", goal="Understand"))
            snapshot = await project_context.preview(session, user_id="owner", project_id=project.id, body=ProjectContextRequest(base_revision=1))

        async def launch(session_id, revision, fingerprint):
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await project_context.create_session(session, user_id="owner", project_id=project.id,
                        body=ProjectContextSessionCreate(base_revision=revision, expected_fingerprint=fingerprint, session_id=session_id))
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        retries = await asyncio.wait_for(asyncio.gather(launch("same-session", 1, snapshot.fingerprint), launch("same-session", 1, snapshot.fingerprint)), timeout=10)
        assert retries[0].id == retries[1].id == "same-session"
        assert retries[0].project_context == retries[1].project_context
        async with AsyncSession(engine, expire_on_commit=False) as session:
            current = await projects.get_project(session, user_id="owner", project_id=project.id)
            assert current.revision == 2 and current.resource_counts == {"chat_session": 1}
            snapshot = await project_context.preview(session, user_id="owner", project_id=project.id, body=ProjectContextRequest(base_revision=2))
        launches = await asyncio.wait_for(asyncio.gather(launch("first-session", 2, snapshot.fingerprint), launch("second-session", 2, snapshot.fingerprint)), timeout=10)
        assert sum(result == 409 for result in launches) == 1
        async with engine.begin() as connection:
            assert (await connection.execute(text("SELECT count(*) FROM chat_sessions"))).scalar_one() == 3
            assert (await connection.execute(text("SELECT count(*) FROM project_resources"))).scalar_one() == 2
            with pytest.raises(RuntimeError, match="explicitly clear project session contexts"):
                await connection.run_sync(lambda sync: migration("c9d0e1f2a3b4_project_chat_context.py", sync).downgrade())
            await connection.execute(text("UPDATE chat_sessions SET project_context=NULL"))
            await connection.run_sync(lambda sync: migration("c9d0e1f2a3b4_project_chat_context.py", sync).downgrade())
            columns = await connection.run_sync(lambda sync: {column["name"] for column in inspect(sync).get_columns("chat_sessions")})
            assert "project_context" not in columns
            await connection.run_sync(lambda sync: migration("c9d0e1f2a3b4_project_chat_context.py", sync).upgrade())
            assert (await connection.execute(text("SELECT count(*) FROM chat_sessions"))).scalar_one() == 3
    finally:
        await engine.dispose()
        if created:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()
