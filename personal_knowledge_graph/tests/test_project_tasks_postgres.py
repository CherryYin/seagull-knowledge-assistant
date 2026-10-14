import asyncio
import os
import uuid
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from pkg.config import settings
from pkg.models.calendar_reminder import CalendarReminderNote
from pkg.models.calendar_reminder_completion import CalendarReminderCompletion
from pkg.models.foundation.note import Note
from pkg.models.user import User
from pkg.schemas.application.project import ProjectCreate, ProjectNextTask
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderUpdate
from pkg.services.application import projects, reminders


def migration(name, connection):
    path = Path(__file__).parents[1] / "alembic/versions" / name
    spec = spec_from_file_location(name, path)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    return module


@pytest.mark.skipif(os.environ.get("SEAGULL_PROJECT_POSTGRES_TEST") != "1", reason="Requires explicit PostgreSQL test opt-in")
@pytest.mark.asyncio
async def test_task_migration_concurrency_real_timestamps_and_safe_downgrade():
    schema = f"project_tasks_test_{uuid.uuid4().hex}"
    admin = create_async_engine(settings.DATABASE_URL)
    engine = create_async_engine(settings.DATABASE_URL, connect_args={"server_settings": {"search_path": schema}})
    created = False
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        async with engine.begin() as connection:
            for table in [User.__tablename__, "sources", "wiki_pages", "assets", "chat_sessions"]:
                await connection.execute(text(f'CREATE TABLE "{table}" (id VARCHAR PRIMARY KEY)'))
            columns = ", ".join(f'"{column.name}" {column.type.compile(dialect=engine.dialect)}' + (" PRIMARY KEY" if column.primary_key else "") for column in Note.__table__.columns)
            await connection.execute(text(f"CREATE TABLE notes ({columns})"))
            await connection.execute(text("CREATE TABLE calendar_reminders (id VARCHAR PRIMARY KEY, user_id VARCHAR NOT NULL, date VARCHAR(10) NOT NULL, text TEXT NOT NULL, note_id VARCHAR, recurrence VARCHAR(20) NOT NULL DEFAULT 'once', is_done BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"))
            await connection.execute(text("INSERT INTO users (id) VALUES ('owner')"))
            await connection.execute(text("INSERT INTO calendar_reminders (id, user_id, date, text, is_done) VALUES ('legacy-done', 'owner', '2026-01-01', 'Legacy task', true)"))
            await connection.run_sync(lambda sync: migration("f6a7b8c9d0e2_add_projects.py", sync).upgrade())
            await connection.run_sync(lambda sync: migration("a7b8c9d0e3f4_project_tasks.py", sync).upgrade())
            await connection.run_sync(lambda sync: migration("b8c9d0e1f2a3_todo_resources.py", sync).upgrade())
            await connection.run_sync(CalendarReminderCompletion.__table__.create)
            await connection.run_sync(CalendarReminderNote.__table__.create)
            legacy = (await connection.execute(text("SELECT completed_at FROM calendar_reminders WHERE id='legacy-done'"))).scalar_one()
            assert legacy is None
        async with AsyncSession(engine, expire_on_commit=False) as session:
            project = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="Tasks", goal="One shared task system"))

        async def create():
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await reminders.create_reminder(session, user_id="owner", body=CalendarReminderCreate(text="Next action", project_id=project.id, base_revision=1))
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        results = await asyncio.gather(create(), create())
        assert sum(result == 409 for result in results) == 1
        task = next(result for result in results if result != 409)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            await reminders.set_next_task(session, user_id="owner", project_id=project.id, body=ProjectNextTask(base_revision=2, reminder_id=task.id))
            changed = await reminders.update_reminder(session, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(date="2026-10-13"))
            assert changed.date == "2026-10-13"

        async def complete():
            async with AsyncSession(engine, expire_on_commit=False) as session:
                return await reminders.update_reminder(session, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=True))

        completed = await asyncio.gather(complete(), complete())
        assert completed[0].completed_at == completed[1].completed_at
        assert completed[0].completed_at.tzinfo is not None
        async with AsyncSession(engine, expire_on_commit=False) as session:
            current = await projects.get_project(session, user_id="owner", project_id=project.id)
            assert current.revision == 4 and current.next_reminder_id is None
            await reminders.update_reminder(session, user_id="owner", reminder_id=task.id, body=CalendarReminderUpdate(is_done=False, date=None))
        async with engine.begin() as connection:
            await connection.run_sync(lambda sync: migration("b8c9d0e1f2a3_todo_resources.py", sync).downgrade())
            with pytest.raises(RuntimeError, match="Schedule unscheduled tasks"):
                await connection.run_sync(lambda sync: migration("a7b8c9d0e3f4_project_tasks.py", sync).downgrade())
            assert (await connection.execute(text("SELECT count(*) FROM calendar_reminders WHERE date IS NULL"))).scalar_one() == 1
            await connection.execute(text("UPDATE calendar_reminders SET date='2026-10-13' WHERE date IS NULL"))
            await connection.run_sync(lambda sync: migration("a7b8c9d0e3f4_project_tasks.py", sync).downgrade())
            assert (await connection.execute(text("SELECT count(*) FROM calendar_reminders"))).scalar_one() == 2
            columns = await connection.run_sync(lambda sync: {column["name"] for column in inspect(sync).get_columns("calendar_reminders")})
            assert "project_id" not in columns and "completed_at" not in columns
    finally:
        await engine.dispose()
        if created:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()
