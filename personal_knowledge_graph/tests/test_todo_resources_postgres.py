import asyncio
import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from pkg.config import settings
from pkg.models.application.asset import Asset
from pkg.models.calendar_reminder import CalendarReminderNote
from pkg.models.calendar_reminder_completion import CalendarReminderCompletion
from pkg.models.foundation.note import Note
from pkg.schemas.application.project import ProjectCreate, ProjectSavedResultLink, TodoResourcesAdd
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderUpdate
from pkg.services.application import project_results, projects, reminders, todo_resources
from tests.test_project_tasks_postgres import migration


@pytest.mark.skipif(os.environ.get("SEAGULL_PROJECT_POSTGRES_TEST") != "1", reason="Requires explicit PostgreSQL test opt-in")
@pytest.mark.asyncio
async def test_todo_resource_migration_concurrent_writes_moves_and_safe_downgrade():
    schema = f"todo_resources_test_{uuid.uuid4().hex}"
    admin = create_async_engine(settings.DATABASE_URL)
    engine = create_async_engine(settings.DATABASE_URL, connect_args={"server_settings": {"search_path": schema}})
    created = False
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        async with engine.begin() as connection:
            for table in ["users", "sources", "wiki_pages", "chat_sessions"]:
                await connection.execute(text(f'CREATE TABLE "{table}" (id VARCHAR PRIMARY KEY)'))
            for model in [Note, Asset]:
                columns = ", ".join(f'"{column.name}" {column.type.compile(dialect=engine.dialect)}' + (" PRIMARY KEY" if column.primary_key else "") for column in model.__table__.columns)
                await connection.execute(text(f'CREATE TABLE "{model.__tablename__}" ({columns})'))
            await connection.execute(text("CREATE TABLE calendar_reminders (id VARCHAR PRIMARY KEY, user_id VARCHAR NOT NULL, date VARCHAR(10) NOT NULL, text TEXT NOT NULL, note_id VARCHAR, recurrence VARCHAR(20) NOT NULL DEFAULT 'once', is_done BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"))
            await connection.execute(text("INSERT INTO users (id) VALUES ('owner')"))
            await connection.execute(text("INSERT INTO notes (id,user_id,title) VALUES ('note-one','owner','Context')"))
            await connection.execute(text("INSERT INTO assets (id,user_id,title) VALUES ('asset-one','owner','Result')"))
            for name in ["f6a7b8c9d0e2_add_projects.py", "a7b8c9d0e3f4_project_tasks.py", "b8c9d0e1f2a3_todo_resources.py"]:
                await connection.run_sync(lambda sync, name=name: migration(name, sync).upgrade())
            await connection.run_sync(CalendarReminderNote.__table__.create)
            await connection.run_sync(CalendarReminderCompletion.__table__.create)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            first = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="First", goal="Ship"))
            second = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="Second", goal="Ship"))
            task = await reminders.create_reminder(session, user_id="owner", body=CalendarReminderCreate(text="Deliver", project_id=first.id, base_revision=1))

        async def add(role, revision):
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await todo_resources.add_resources(session, user_id="owner", project_id=first.id, reminder_id=task.id,
                        body=TodoResourcesAdd(base_revision=revision, role=role, resources=[{"resource_type": "asset" if role == "result" else "note", "resource_id": "asset-one" if role == "result" else "note-one"}]))
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        concurrent = await asyncio.gather(add("result", 2), add("result", 2))
        assert sum(result == 409 for result in concurrent) == 1
        async with engine.connect() as connection:
            assert (await connection.execute(text("SELECT count(*) FROM todo_resources"))).scalar_one() == 1

        async def complete():
            async with AsyncSession(engine, expire_on_commit=False) as session:
                return await reminders.update_reminder(session, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=True))

        result, completed = await asyncio.gather(add("context", 3), complete())
        assert result.total == 2 and completed.completed_at is not None
        async with AsyncSession(engine, expire_on_commit=False) as session:
            summary = await todo_resources.project_results(session, user_id="owner", project_id=first.id)
            assert summary.items[0].task_done
            other_task = await reminders.create_reminder(session, user_id="owner", body=CalendarReminderCreate(text="Other", project_id=second.id, base_revision=1))

        async def move(reminder_id, source_id, destination_id, source_revision, target_revision):
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await reminders.update_reminder(session, user_id="owner", reminder_id=reminder_id, expected_project=source_id,
                        body=CalendarReminderUpdate(project_id=destination_id, base_revision=source_revision, target_revision=target_revision))
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        moves = await asyncio.wait_for(asyncio.gather(move(task.id, first.id, second.id, 4, 2), move(other_task.id, second.id, first.id, 2, 4)), timeout=10)
        assert sum(result == 409 for result in moves) == 1
        async with AsyncSession(engine, expire_on_commit=False) as session:
            current = await reminders._owned_reminder(session, "owner", task.id)
            listed = await todo_resources.list_resources(session, user_id="owner", project_id=current.project_id, reminder_id=task.id)
            assert listed.total == 2
            counts = (await projects.get_project(session, user_id="owner", project_id=current.project_id)).resource_counts
            assert counts["asset"] == 1 and counts["note"] == 1
            destination_id = current.project_id
            revision = (await projects.get_project(session, user_id="owner", project_id=destination_id)).revision

        async def link_result(kind, base_revision):
            async with AsyncSession(engine, expire_on_commit=False) as session:
                return await project_results.link_saved_result(session, user_id="owner", project_id=destination_id,
                    body=ProjectSavedResultLink(base_revision=base_revision, resource_type=kind,
                        resource_id=f"{kind}-one", reminder_id=task.id))

        retried = await link_result("asset", 1)
        assert retried.project.revision == revision
        confirmed = await asyncio.wait_for(asyncio.gather(link_result("note", revision), link_result("note", revision)), timeout=10)
        assert confirmed[0].project.revision == confirmed[1].project.revision == revision + 1
        async with engine.begin() as connection:
            with pytest.raises(RuntimeError, match="associations will not be silently discarded"):
                await connection.run_sync(lambda sync: migration("b8c9d0e1f2a3_todo_resources.py", sync).downgrade())
            assert (await connection.execute(text("SELECT count(*) FROM todo_resources"))).scalar_one() == 3
            await connection.execute(text("DELETE FROM todo_resources"))
            await connection.run_sync(lambda sync: migration("b8c9d0e1f2a3_todo_resources.py", sync).downgrade())
            tables = await connection.run_sync(lambda sync: inspect(sync).get_table_names())
            assert "todo_resources" not in tables
            assert (await connection.execute(text("SELECT count(*) FROM calendar_reminders"))).scalar_one() == 2
            await connection.run_sync(lambda sync: migration("b8c9d0e1f2a3_todo_resources.py", sync).upgrade())
    finally:
        await engine.dispose()
        if created:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()
