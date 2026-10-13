from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.application.project import (
    ProjectCreate, ProjectList, ProjectRead, ProjectResourceList, ProjectResourceOptions,
    ProjectResourcesAdd, ProjectResourcesResult, ProjectResourceType, ProjectRevisionRequest,
    ProjectStatus, ProjectUpdate,
)
from pkg.services.application import projects


router = APIRouter()


@router.get("", response_model=ProjectList)
async def list_projects(status: ProjectStatus | None = None, archived: bool = False,
                        query: str = Query(default="", max_length=200),
                        limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                        user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await projects.list_projects(session, user_id=user.id, status=status, archived=archived,
                                        query=query, limit=limit, offset=offset)


@router.post("", response_model=ProjectRead, status_code=201)
async def create_project(body: ProjectCreate, user: User = Depends(get_current_user),
                         session: AsyncSession = Depends(get_session)):
    return await projects.create_project(session, user_id=user.id, body=body)


@router.get("/resource-options", response_model=ProjectResourceOptions)
async def resource_options(resource_type: ProjectResourceType, query: str = Query(default="", max_length=200),
                           limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                           user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await projects.resource_options(session, user_id=user.id, resource_type=resource_type,
                                          query=query, limit=limit, offset=offset)


@router.get("/for-resource", response_model=ProjectList)
async def projects_for_resource(resource_type: ProjectResourceType, resource_id: str = Query(min_length=1, max_length=200),
                                limit: int = Query(default=20, ge=1, le=100), offset: int = Query(default=0, ge=0),
                                user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await projects.projects_for_resource(session, user_id=user.id, resource_type=resource_type,
                                               resource_id=resource_id, limit=limit, offset=offset)


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(project_id: str, user: User = Depends(get_current_user),
                      session: AsyncSession = Depends(get_session)):
    return await projects.get_project(session, user_id=user.id, project_id=project_id)


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(project_id: str, body: ProjectUpdate, user: User = Depends(get_current_user),
                         session: AsyncSession = Depends(get_session)):
    return await projects.update_project(session, user_id=user.id, project_id=project_id, body=body)


@router.post("/{project_id}/archive", response_model=ProjectRead)
async def archive_project(project_id: str, body: ProjectRevisionRequest, user: User = Depends(get_current_user),
                          session: AsyncSession = Depends(get_session)):
    return await projects.archive_project(session, user_id=user.id, project_id=project_id, base_revision=body.base_revision)


@router.post("/{project_id}/restore", response_model=ProjectRead)
async def restore_project(project_id: str, body: ProjectRevisionRequest, user: User = Depends(get_current_user),
                          session: AsyncSession = Depends(get_session)):
    return await projects.archive_project(session, user_id=user.id, project_id=project_id,
                                          base_revision=body.base_revision, restore=True)


@router.get("/{project_id}/resources", response_model=ProjectResourceList)
async def list_resources(project_id: str, resource_type: ProjectResourceType | None = None,
                         limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                         user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await projects.list_resources(session, user_id=user.id, project_id=project_id,
                                        resource_type=resource_type, limit=limit, offset=offset)


@router.post("/{project_id}/resources", response_model=ProjectResourcesResult)
async def add_resources(project_id: str, body: ProjectResourcesAdd, user: User = Depends(get_current_user),
                        session: AsyncSession = Depends(get_session)):
    return await projects.add_resources(session, user_id=user.id, project_id=project_id, body=body)


@router.delete("/{project_id}/resources/{link_id}", response_model=ProjectRead)
async def remove_resource(project_id: str, link_id: str, base_revision: int = Query(ge=1),
                           user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await projects.remove_resource(session, user_id=user.id, project_id=project_id,
                                         link_id=link_id, base_revision=base_revision)
