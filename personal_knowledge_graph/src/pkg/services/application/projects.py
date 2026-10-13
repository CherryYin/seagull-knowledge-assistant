from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from pkg.models.application.asset import Asset
from pkg.models.application.project import Project, ProjectResource, RESOURCE_COLUMNS
from pkg.models.chat_session import ChatSession
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.schemas.application.project import (
    ProjectCreate, ProjectList, ProjectRead, ProjectResourceInput, ProjectResourceList,
    ProjectResourceOption, ProjectResourceOptions, ProjectResourceRead, ProjectResourcesAdd,
    ProjectResourcesResult, ProjectUpdate,
)


TARGET_MODELS = {"source": Source, "note": Note, "wiki": WikiPage, "asset": Asset, "chat_session": ChatSession}
TARGET_ROUTES = {"source": "/sources/", "note": "/notes/", "wiki": "/wiki/", "asset": "/assets/", "chat_session": "/chat"}


def _target_query(model):
    names = ["id", "user_id", "title", "status", "lifecycle_status", "updated_at", "ingested_at"]
    if model is Source:
        names.extend(["source_type", "metadata_"])
    return select(model).options(load_only(*(getattr(model, name) for name in names if hasattr(model, name)), raiseload=True))


async def owned_project(session: AsyncSession, user_id: str, project_id: str, *, lock=False) -> Project:
    statement = select(Project).where(Project.id == project_id, Project.user_id == user_id)
    if lock:
        statement = statement.with_for_update()
    project = (await session.execute(statement)).scalar_one_or_none()
    if project is None:
        raise HTTPException(404, "Project not found")
    return project


def check_revision(project: Project, revision: int, *, allow_archived=False):
    if project.revision != revision:
        raise HTTPException(409, "Project changed. Refresh it before retrying; your changes have not been applied.")
    if project.archived_at and not allow_archived:
        raise HTTPException(409, "Project is archived. Restore it before making changes.")


async def _read_projects(session: AsyncSession, projects: list[Project]) -> list[ProjectRead]:
    if not projects:
        return []
    rows = await session.execute(select(ProjectResource.project_id, ProjectResource.resource_type, func.count())
        .where(ProjectResource.project_id.in_([project.id for project in projects]))
        .group_by(ProjectResource.project_id, ProjectResource.resource_type))
    counts = defaultdict(dict)
    for project_id, kind, total in rows.all():
        counts[project_id][kind] = total
    return [ProjectRead.model_validate(project).model_copy(update={"resource_counts": counts[project.id]})
            for project in projects]


async def get_project(session: AsyncSession, *, user_id: str, project_id: str) -> ProjectRead:
    return (await _read_projects(session, [await owned_project(session, user_id, project_id)]))[0]


async def list_projects(session: AsyncSession, *, user_id: str, status=None, archived=False,
                        query="", limit=30, offset=0) -> ProjectList:
    filters = [Project.user_id == user_id, Project.archived_at.is_not(None) if archived else Project.archived_at.is_(None)]
    if status:
        filters.append(Project.status == status)
    if query:
        filters.append(Project.title.icontains(query, autoescape=True))
    total = (await session.execute(select(func.count()).select_from(Project).where(*filters))).scalar_one()
    projects = list((await session.execute(select(Project).where(*filters)
        .order_by(Project.updated_at.desc(), Project.id).limit(limit).offset(offset))).scalars())
    return ProjectList(items=await _read_projects(session, projects), total=total)


async def create_project(session: AsyncSession, *, user_id: str, body: ProjectCreate) -> ProjectRead:
    project = Project(user_id=user_id, **body.model_dump())
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return ProjectRead.model_validate(project)


def _advance(project: Project):
    project.revision += 1
    project.updated_at = datetime.now(timezone.utc)


async def update_project(session: AsyncSession, *, user_id: str, project_id: str, body: ProjectUpdate) -> ProjectRead:
    project = await owned_project(session, user_id, project_id, lock=True)
    check_revision(project, body.base_revision)
    changes = body.model_dump(exclude_unset=True, exclude={"base_revision"})
    changed = any(getattr(project, name) != value for name, value in changes.items())
    if changed:
        if "status" in changes and changes["status"] != project.status:
            project.completed_at = datetime.now(timezone.utc) if changes["status"] == "completed" else None
        for name, value in changes.items():
            setattr(project, name, value)
        _advance(project)
    await session.commit()
    await session.refresh(project)
    return (await _read_projects(session, [project]))[0]


async def archive_project(session: AsyncSession, *, user_id: str, project_id: str,
                          base_revision: int, restore=False) -> ProjectRead:
    project = await owned_project(session, user_id, project_id, lock=True)
    check_revision(project, base_revision, allow_archived=True)
    if bool(project.archived_at) != (not restore):
        project.archived_at = None if restore else datetime.now(timezone.utc)
        _advance(project)
    await session.commit()
    await session.refresh(project)
    return (await _read_projects(session, [project]))[0]


async def _load_targets(session: AsyncSession, user_id: str, refs: list[ProjectResourceInput], *, lock=False):
    grouped = defaultdict(set)
    for ref in refs:
        grouped[ref.resource_type].add(ref.resource_id)
    targets = {}
    for kind in sorted(grouped):
        model = TARGET_MODELS[kind]
        statement = _target_query(model).where(model.id.in_(grouped[kind]), model.user_id == user_id)
        if lock:
            statement = statement.order_by(model.id).with_for_update(read=True)
        records = list((await session.execute(statement)).scalars())
        if {record.id for record in records} != grouped[kind]:
            raise HTTPException(404, "One or more selected resources are unavailable. No resources were added.")
        targets.update({(kind, record.id): record for record in records})
    return targets


def _option(kind: str, target) -> ProjectResourceOption:
    href = TARGET_ROUTES[kind]
    href += f"?session={quote(target.id, safe='')}" if kind == "chat_session" else quote(target.id, safe="")
    status = getattr(target, "status", None) or getattr(target, "lifecycle_status", None)
    if kind == "source":
        status = (target.metadata_ or {}).get("review_status") or target.source_type
    return ProjectResourceOption(resource_type=kind, resource_id=target.id, title=target.title or "Untitled",
        status=status, href=href, updated_at=getattr(target, "updated_at", None) or getattr(target, "ingested_at", None))


async def list_resources(session: AsyncSession, *, user_id: str, project_id: str,
                          resource_type=None, limit=30, offset=0) -> ProjectResourceList:
    project = await owned_project(session, user_id, project_id)
    filters = [ProjectResource.project_id == project.id]
    if resource_type:
        filters.append(ProjectResource.resource_type == resource_type)
    total = (await session.execute(select(func.count()).select_from(ProjectResource).where(*filters))).scalar_one()
    links = list((await session.execute(select(ProjectResource).where(*filters)
        .order_by(ProjectResource.created_at.desc(), ProjectResource.id).limit(limit).offset(offset))).scalars())
    refs = [ProjectResourceInput(resource_type=link.resource_type,
            resource_id=getattr(link, RESOURCE_COLUMNS[link.resource_type])) for link in links]
    targets = await _load_targets(session, user_id, refs)
    items = [ProjectResourceRead(**_option(ref.resource_type, targets[(ref.resource_type, ref.resource_id)]).model_dump(),
             id=link.id, reason=link.reason, created_at=link.created_at) for link, ref in zip(links, refs)]
    return ProjectResourceList(items=items, total=total, revision=project.revision)


async def add_resources(session: AsyncSession, *, user_id: str, project_id: str,
                         body: ProjectResourcesAdd) -> ProjectResourcesResult:
    project = await owned_project(session, user_id, project_id, lock=True)
    check_revision(project, body.base_revision)
    refs = list({(ref.resource_type, ref.resource_id): ref for ref in body.resources}.values())
    await _load_targets(session, user_id, refs, lock=True)
    links = list((await session.execute(select(ProjectResource).where(ProjectResource.project_id == project.id))).scalars())
    existing = {(link.resource_type, getattr(link, RESOURCE_COLUMNS[link.resource_type])) for link in links}
    added = 0
    for ref in refs:
        if (ref.resource_type, ref.resource_id) not in existing:
            session.add(ProjectResource(project_id=project.id, resource_type=ref.resource_type,
                reason=ref.reason, **{RESOURCE_COLUMNS[ref.resource_type]: ref.resource_id}))
            added += 1
    if added:
        _advance(project)
    await session.commit()
    await session.refresh(project)
    return ProjectResourcesResult(project=(await _read_projects(session, [project]))[0], added=added)


async def remove_resource(session: AsyncSession, *, user_id: str, project_id: str,
                           link_id: str, base_revision: int) -> ProjectRead:
    project = await owned_project(session, user_id, project_id, lock=True)
    check_revision(project, base_revision)
    link = (await session.execute(select(ProjectResource).where(
        ProjectResource.id == link_id, ProjectResource.project_id == project.id))).scalar_one_or_none()
    if link is None:
        raise HTTPException(404, "Project resource link not found")
    await session.delete(link)
    _advance(project)
    await session.commit()
    await session.refresh(project)
    return (await _read_projects(session, [project]))[0]


async def resource_options(session: AsyncSession, *, user_id: str, resource_type: str,
                            query="", limit=30, offset=0) -> ProjectResourceOptions:
    model = TARGET_MODELS[resource_type]
    filters = [model.user_id == user_id]
    if query:
        filters.append(model.title.icontains(query, autoescape=True))
    total = (await session.execute(select(func.count()).select_from(model).where(*filters))).scalar_one()
    targets = list((await session.execute(_target_query(model).where(*filters).order_by(model.id)
        .limit(limit).offset(offset))).scalars())
    return ProjectResourceOptions(items=[_option(resource_type, target) for target in targets], total=total)


async def projects_for_resource(session: AsyncSession, *, user_id: str, resource_type: str,
                                 resource_id: str, limit=20, offset=0) -> ProjectList:
    await _load_targets(session, user_id, [ProjectResourceInput(resource_type=resource_type, resource_id=resource_id)])
    target_column = getattr(ProjectResource, RESOURCE_COLUMNS[resource_type])
    statement = select(Project).join(ProjectResource, ProjectResource.project_id == Project.id).where(
        Project.user_id == user_id, target_column == resource_id)
    total = (await session.execute(select(func.count()).select_from(statement.subquery()))).scalar_one()
    projects = list((await session.execute(statement.order_by(Project.updated_at.desc(), Project.id)
        .limit(limit).offset(offset))).scalars())
    return ProjectList(items=await _read_projects(session, projects), total=total)
