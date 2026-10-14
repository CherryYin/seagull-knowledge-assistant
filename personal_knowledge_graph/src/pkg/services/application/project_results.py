from fastapi import HTTPException
from sqlalchemy import select

from pkg.models.application.project import ProjectResource, RESOURCE_COLUMNS, TodoResource
from pkg.schemas.application.project import ProjectResourceInput, ProjectSavedResultRead
from pkg.services.application import projects, reminders


async def link_saved_result(session, *, user_id, project_id, body):
    project = await projects.owned_project(session, user_id, project_id, lock=True)
    projects.check_revision(project, project.revision)
    ref = ProjectResourceInput(resource_type=body.resource_type, resource_id=body.resource_id)
    if body.reminder_id:
        task = await reminders._owned_reminder(session, user_id, body.reminder_id)
        await reminders._lock_reminder(session, task)
        if task.project_id != project_id:
            raise HTTPException(404, "Task does not belong to this project; saved content is unchanged")
        if task.recurrence != "once":
            raise HTTPException(422, "Results belong to one-time actions, not recurring reminder templates")
    await projects._load_targets(session, user_id, [ref], lock=True)
    column = RESOURCE_COLUMNS[body.resource_type]
    project_link = (await session.execute(select(ProjectResource).where(
        ProjectResource.project_id == project_id, ProjectResource.resource_type == body.resource_type,
        getattr(ProjectResource, column) == body.resource_id))).scalar_one_or_none()
    task_link = None
    if body.reminder_id:
        task_link = (await session.execute(select(TodoResource).where(
            TodoResource.reminder_id == body.reminder_id, TodoResource.role == "result",
            TodoResource.resource_type == body.resource_type,
            getattr(TodoResource, column) == body.resource_id))).scalar_one_or_none()
    if project_link is None or (body.reminder_id and task_link is None):
        projects.check_revision(project, body.base_revision)
        if project_link is None:
            session.add(ProjectResource(project_id=project_id, resource_type=body.resource_type,
                reason="Explicit saved result", **{column: body.resource_id}))
        if body.reminder_id and task_link is None:
            session.add(TodoResource(reminder_id=body.reminder_id, role="result", resource_type=body.resource_type,
                reason="Explicit saved result", **{column: body.resource_id}))
        projects._advance(project)
    await session.commit()
    return ProjectSavedResultRead(project=await projects.get_project(session, user_id=user_id, project_id=project_id),
        resource_type=body.resource_type, resource_id=body.resource_id, reminder_id=body.reminder_id)
