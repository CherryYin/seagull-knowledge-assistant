import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import func, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from pkg.config import settings
from pkg.models.application.asset import Asset, AssetVisual
from pkg.models.application.mind_map import MindMap
from pkg.models.application.project import Project, ProjectResource
from pkg.schemas.application.project import ProjectCreate
from pkg.services.application.asset_analytics import get_asset_analytics
from pkg.services.application import projects


@pytest.mark.skipif(os.environ.get("SEAGULL_PROJECT_POSTGRES_TEST") != "1", reason="Requires explicit PostgreSQL test opt-in")
@pytest.mark.asyncio
async def test_project_analytics_counts_all_linked_assets_once_and_scopes_related_signals():
    schema = f"project_analytics_test_{uuid.uuid4().hex}"
    admin = create_async_engine(settings.DATABASE_URL)
    engine = create_async_engine(settings.DATABASE_URL, connect_args={"server_settings": {"search_path": schema}})
    created = False
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        async with engine.begin() as connection:
            for name in ["users", "sources", "notes", "wiki_pages", "chat_sessions"]:
                await connection.execute(text(f'CREATE TABLE "{name}" (id VARCHAR PRIMARY KEY)'))
            for model in [Asset, AssetVisual, MindMap]:
                columns = ", ".join(f'"{column.name}" {column.type.compile(dialect=engine.dialect)}' + (" PRIMARY KEY" if column.primary_key else "") for column in model.__table__.columns)
                await connection.execute(text(f'CREATE TABLE "{model.__tablename__}" ({columns})'))
            await connection.execute(text("CREATE TABLE calendar_reminders (id VARCHAR PRIMARY KEY)"))
            await connection.run_sync(Project.__table__.create)
            await connection.run_sync(ProjectResource.__table__.create)
            await connection.execute(text("INSERT INTO users (id) VALUES ('owner'), ('other')"))
            await connection.execute(text("INSERT INTO notes (id) VALUES ('note-one')"))
            for index in range(41):
                await connection.execute(Asset.__table__.insert().values(id=f"asset-{index}", title=f"Asset {index}",
                    user_id="owner" if index < 40 else "other", asset_type="blog_post", status="draft", brief="Question",
                    outline="Outline", draft_content="# Saved draft", reference_notes="Reference", source_refs=["source-one"],
                    note_refs=[], wiki_refs=[], metadata={}, created_at=func.now(), updated_at=func.now()))
            for visual_id, asset_id, owner in [("included", "asset-0", "owner"), ("outside", "asset-39", "owner"), ("foreign", "asset-0", "other")]:
                await connection.execute(text("INSERT INTO asset_visuals (id,asset_id,user_id,role,status,processing_attempts,created_at) VALUES (:id,:asset,:owner,'cover','failed',2,NOW())"),
                    {"id": visual_id, "asset": asset_id, "owner": owner})
            for map_id, asset_id, owner in [("outside", "asset-39", "owner"), ("foreign", "asset-0", "other")]:
                await connection.execute(text("INSERT INTO mind_maps (id,user_id,owner_type,owner_id,purpose,generation_status) VALUES (:id,:owner,'asset',:asset,'asset_outline','failed')"),
                    {"id": map_id, "asset": asset_id, "owner": owner})
        async with AsyncSession(engine, expire_on_commit=False) as session:
            first = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="First", goal="Ship"))
            second = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="Second", goal="Ship"))
            empty = await projects.create_project(session, user_id="owner", body=ProjectCreate(title="Empty", goal="Explore"))
            private = await projects.create_project(session, user_id="other", body=ProjectCreate(title="Private", goal="Private"))
            for index in [*range(35), 40]:
                session.add(ProjectResource(project_id=first.id, resource_type="asset", asset_id=f"asset-{index}"))
            session.add(ProjectResource(project_id=second.id, resource_type="asset", asset_id="asset-0"))
            session.add(ProjectResource(project_id=first.id, resource_type="note", note_id="note-one"))
            await session.commit()
            await projects.archive_project(session, user_id="owner", project_id=first.id, base_revision=1)
            scoped = await get_asset_analytics(session, user_id="owner", project_id=first.id, feature="blocks", offset=30, limit=2)
            assert scoped.project_id == first.id and scoped.project_archived
            assert scoped.total_assets == scoped.assets_without_workspace == scoped.issue_total == 35
            assert len(scoped.issues) == 2 and all(issue.asset_id != "asset-40" for issue in scoped.issues)
            assert scoped.visual_metrics.total_tasks == scoped.visual_metrics.retry_attempts == 1
            assert next(item for item in scoped.features if item.feature == "outline").recorded_failure_assets == 0
            shared = await get_asset_analytics(session, user_id="owner", project_id=second.id)
            assert shared.total_assets == 1 and shared.visual_metrics.total_tasks == 1
            global_result = await get_asset_analytics(session, user_id="owner")
            assert global_result.project_id is None and global_result.total_assets == 40 and global_result.visual_metrics.total_tasks == 2
            filtered = await get_asset_analytics(session, user_id="owner", project_id=first.id, status="published")
            assert filtered.total_assets == 0 and filtered.project_id == first.id
            assert (await get_asset_analytics(session, user_id="owner", project_id=empty.id)).total_assets == 0
            assert (await projects.get_project(session, user_id="owner", project_id=first.id)).revision == 2
            for unavailable in [private.id, "missing"]:
                with pytest.raises(HTTPException) as error:
                    await get_asset_analytics(session, user_id="owner", project_id=unavailable)
                assert error.value.status_code == 404
    finally:
        await engine.dispose()
        if created:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()
