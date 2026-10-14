from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.application.project import (
    ProjectCreate, ProjectList, ProjectRead, ProjectResourceList, ProjectResourceOptions,
    ProjectResourcesAdd, ProjectResourcesResult, ProjectResourceType, ProjectRevisionRequest,
    ProjectStatus, ProjectUpdate, ProjectNextTask, TodoResourcesAdd, TodoResourceList,
    ProjectContextRequest, ProjectContextSessionCreate, ProjectContextSnapshot,
    ProjectSavedResultLink, ProjectSavedResultRead,
)
from pkg.schemas.chat_session import ChatSessionRead
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderRead, CalendarReminderUpdate, ProjectTaskList
from pkg.services.application import project_context, project_results, projects, reminders, todo_resources


router = APIRouter()


@router.post("/{project_id}/saved-result", response_model=ProjectSavedResultRead)
async def link_saved_result(project_id: str, body: ProjectSavedResultLink, user: User = Depends(get_current_user),
                            session: AsyncSession = Depends(get_session)):
    return await project_results.link_saved_result(session, user_id=user.id, project_id=project_id, body=body)


@router.post("/{project_id}/context-preview", response_model=ProjectContextSnapshot)
async def preview_context(project_id: str, body: ProjectContextRequest, user: User = Depends(get_current_user),
                          session: AsyncSession = Depends(get_session)):
    return await project_context.preview(session, user_id=user.id, project_id=project_id, body=body)


@router.post("/{project_id}/context-session", response_model=ChatSessionRead, status_code=201)
async def create_context_session(project_id: str, body: ProjectContextSessionCreate, user: User = Depends(get_current_user),
                                 session: AsyncSession = Depends(get_session)):
    return await project_context.create_session(session, user_id=user.id, project_id=project_id, body=body)


@router.put("/{project_id}/context-session/{session_id}", response_model=ChatSessionRead)
async def update_context_session(project_id: str, session_id: str, body: ProjectContextRequest,
                                 user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    if not body.expected_fingerprint:
        raise HTTPException(422, "Confirm a context preview before updating a session")
    return await project_context.update_session_context(session, user_id=user.id, project_id=project_id, session_id=session_id, body=body)


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


@router.get("/{project_id}/tasks", response_model=ProjectTaskList)
async def list_tasks(project_id: str, kind: Literal["once", "recurring"] = "once", start: date | None = None,
                     end: date | None = None, include_done: bool = True,
                     limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                     user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await reminders.project_tasks(session, user_id=user.id, project_id=project_id, kind=kind,
        start=start.isoformat() if start else None, end=end.isoformat() if end else None,
        include_done=include_done, limit=limit, offset=offset)


@router.post("/{project_id}/tasks", response_model=CalendarReminderRead, status_code=201)
async def create_task(project_id: str, body: CalendarReminderCreate, user: User = Depends(get_current_user),
                       session: AsyncSession = Depends(get_session)):
    if body.project_id is not None and body.project_id != project_id:
        raise HTTPException(422, "Project in body must match the URL")
    return await reminders.create_reminder(session, user_id=user.id, body=body.model_copy(update={"project_id": project_id}))


@router.patch("/{project_id}/tasks/{reminder_id}", response_model=CalendarReminderRead)
async def update_task(project_id: str, reminder_id: str, body: CalendarReminderUpdate,
                       user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await reminders.update_reminder(session, user_id=user.id, reminder_id=reminder_id, body=body, expected_project=project_id)


@router.post("/{project_id}/tasks/{reminder_id}/attach", response_model=CalendarReminderRead)
async def attach_task(project_id: str, reminder_id: str, body: ProjectRevisionRequest,
                       user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    task = await reminders._owned_reminder(session, user.id, reminder_id)
    if task.project_id not in {None, project_id}:
        raise HTTPException(409, "Task already belongs to another project. Move it explicitly instead.")
    return await reminders.update_reminder(session, user_id=user.id, reminder_id=reminder_id,
        body=CalendarReminderUpdate(project_id=project_id, base_revision=body.base_revision), expected_project=project_id if task.project_id else None)


@router.delete("/{project_id}/tasks/{reminder_id}", response_model=CalendarReminderRead)
async def detach_task(project_id: str, reminder_id: str, base_revision: int = Query(ge=1),
                       user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await reminders.update_reminder(session, user_id=user.id, reminder_id=reminder_id,
        body=CalendarReminderUpdate(project_id=None, base_revision=base_revision), expected_project=project_id)


@router.patch("/{project_id}/next-task", response_model=ProjectRead)
async def set_next_task(project_id: str, body: ProjectNextTask, user: User = Depends(get_current_user),
                         session: AsyncSession = Depends(get_session)):
    return await reminders.set_next_task(session, user_id=user.id, project_id=project_id, body=body)


@router.get("/{project_id}/tasks/{reminder_id}/resources", response_model=TodoResourceList)
async def list_task_resources(project_id: str, reminder_id: str, role: Literal["context", "result"] | None = None,
                              limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                              user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await todo_resources.list_resources(session, user_id=user.id, project_id=project_id,
        reminder_id=reminder_id, role=role, limit=limit, offset=offset)


@router.post("/{project_id}/tasks/{reminder_id}/resources", response_model=TodoResourceList)
async def add_task_resources(project_id: str, reminder_id: str, body: TodoResourcesAdd,
                             user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await todo_resources.add_resources(session, user_id=user.id, project_id=project_id, reminder_id=reminder_id, body=body)


@router.delete("/{project_id}/tasks/{reminder_id}/resources/{link_id}", response_model=TodoResourceList)
async def remove_task_resource(project_id: str, reminder_id: str, link_id: str, base_revision: int = Query(ge=1),
                              user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await todo_resources.remove_resource(session, user_id=user.id, project_id=project_id,
        reminder_id=reminder_id, link_id=link_id, base_revision=base_revision)


@router.get("/{project_id}/task-results", response_model=TodoResourceList)
async def list_task_results(project_id: str, limit: int = Query(default=10, ge=1, le=100), offset: int = Query(default=0, ge=0),
                           user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await todo_resources.project_results(session, user_id=user.id, project_id=project_id, limit=limit, offset=offset)
