import asyncio
import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from pkg.config import settings
from pkg.models.application.project import Project, ProjectResource
from pkg.models.foundation.source import Source
from pkg.models.user import User
from pkg.schemas.application.project import ProjectCreate, ProjectResourcesAdd, ProjectUpdate
from pkg.services.application import projects


@pytest.mark.skipif(os.environ.get("SEAGULL_PROJECT_POSTGRES_TEST") != "1", reason="Requires explicit PostgreSQL test opt-in")
@pytest.mark.asyncio
async def test_postgres_concurrent_edits_and_additions_serialize_without_lost_updates():
    schema = f"project_test_{uuid.uuid4().hex}"
    admin = create_async_engine(settings.DATABASE_URL)
    engine = create_async_engine(settings.DATABASE_URL, connect_args={"server_settings": {"search_path": schema}})
    created_schema = False
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created_schema = True
        async with engine.begin() as connection:
            for table in [User.__tablename__, "sources", "notes", "wiki_pages", "assets", "chat_sessions"]:
                await connection.execute(text(f'CREATE TABLE "{table}" (id VARCHAR PRIMARY KEY)'))
            await connection.execute(text("INSERT INTO users (id) VALUES ('owner')"))
            await connection.run_sync(Project.__table__.create)
            await connection.run_sync(ProjectResource.__table__.create)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            saved = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="Concurrent", goal="Do not lose edits"))

        async def edit(title):
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await projects.update_project(session, user_id="owner", project_id=saved.id,
                        body=ProjectUpdate(base_revision=1, title=title))
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        results = await asyncio.gather(edit("First tab"), edit("Second tab"))
        assert sum(result == 409 for result in results) == 1
        async with AsyncSession(engine, expire_on_commit=False) as session:
            current = await projects.get_project(session, user_id="owner", project_id=saved.id)
            assert current.revision == 2 and current.title in {"First tab", "Second tab"}

        async with engine.begin() as connection:
            for column in Source.__table__.columns:
                if column.name != "id":
                    compiled_type = column.type.compile(dialect=engine.dialect)
                    await connection.execute(text(f'ALTER TABLE sources ADD COLUMN "{column.name}" {compiled_type}'))
            await connection.execute(text("INSERT INTO sources (id, user_id) VALUES ('source-one', 'owner')"))

        async def add():
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await projects.add_resources(session, user_id="owner", project_id=saved.id,
                        body=ProjectResourcesAdd(base_revision=2, resources=[{"resource_type": "source", "resource_id": "source-one"}]))
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        additions = await asyncio.gather(add(), add())
        assert sum(result == 409 for result in additions) == 1
        async with engine.connect() as connection:
            assert (await connection.execute(text("SELECT count(*) FROM project_resources"))).scalar_one() == 1
            assert (await connection.execute(text("SELECT revision FROM projects"))).scalar_one() == 3
    finally:
        await engine.dispose()
        if created_schema:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()
