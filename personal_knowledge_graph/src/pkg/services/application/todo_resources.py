from fastapi import HTTPException
from sqlalchemy import func, select

from pkg.models.application.project import ProjectResource, RESOURCE_COLUMNS, TodoResource
from pkg.models.calendar_reminder import CalendarReminder
from pkg.schemas.application.project import ProjectResourceInput, TodoResourceList, TodoResourceRead
from pkg.services.application import projects, reminders


async def _task_scope(session, user_id, project_id, reminder_id, *, revision=None, lock=False):
    project = await projects.owned_project(session, user_id, project_id, lock=lock)
    if lock:
        projects.check_revision(project, revision)
    task = await reminders._owned_reminder(session, user_id, reminder_id)
    if lock:
        await reminders._lock_reminder(session, task)
    if task.project_id != project_id:
        raise HTTPException(404, "Task does not belong to this project")
    return project, task


async def _listed(session, user_id, filters, *, revision, limit, offset):
    statement = select(TodoResource, CalendarReminder).join(CalendarReminder, CalendarReminder.id == TodoResource.reminder_id).where(
        CalendarReminder.user_id == user_id, *filters)
    total = (await session.execute(select(func.count()).select_from(statement.subquery()))).scalar_one()
    rows = (await session.execute(statement.order_by(TodoResource.created_at.desc(), TodoResource.id)
        .limit(limit).offset(offset))).all()
    refs = [ProjectResourceInput(resource_type=link.resource_type, resource_id=getattr(link, RESOURCE_COLUMNS[link.resource_type])) for link, _task in rows]
    targets = await projects._load_targets(session, user_id, refs)
    items = [TodoResourceRead(**projects._option(ref.resource_type, targets[(ref.resource_type, ref.resource_id)]).model_dump(),
        id=link.id, reason=link.reason, created_at=link.created_at, role=link.role, reminder_id=task.id,
        task_text=task.text, task_done=task.is_done) for (link, task), ref in zip(rows, refs)]
    return TodoResourceList(items=items, total=total, revision=revision)


async def list_resources(session, *, user_id, reminder_id, project_id=None, role=None, limit=30, offset=0):
    if project_id:
        project, _task = await _task_scope(session, user_id, project_id, reminder_id)
        revision = project.revision
    else:
        await reminders._owned_reminder(session, user_id, reminder_id)
        revision = None
    filters = [TodoResource.reminder_id == reminder_id]
    if role:
        filters.append(TodoResource.role == role)
    return await _listed(session, user_id, filters, revision=revision, limit=limit, offset=offset)


async def project_results(session, *, user_id, project_id, limit=10, offset=0):
    project = await projects.owned_project(session, user_id, project_id)
    return await _listed(session, user_id, [CalendarReminder.project_id == project_id, TodoResource.role == "result"],
        revision=project.revision, limit=limit, offset=offset)


async def join_project_resources(session, *, user_id, project_id, refs):
    await projects._load_targets(session, user_id, refs, lock=True)
    existing = list((await session.execute(select(ProjectResource).where(ProjectResource.project_id == project_id))).scalars())
    keys = {(link.resource_type, getattr(link, RESOURCE_COLUMNS[link.resource_type])) for link in existing}
    added = 0
    for ref in refs:
        key = (ref.resource_type, ref.resource_id)
        if key not in keys:
            session.add(ProjectResource(project_id=project_id, resource_type=ref.resource_type,
                reason="Task resource", **{RESOURCE_COLUMNS[ref.resource_type]: ref.resource_id}))
            keys.add(key)
            added += 1
    return added


async def carry_resources(session, *, user_id, project_id, reminder_id):
    links = list((await session.execute(select(TodoResource).where(TodoResource.reminder_id == reminder_id))).scalars())
    refs = [ProjectResourceInput(resource_type=link.resource_type, resource_id=getattr(link, RESOURCE_COLUMNS[link.resource_type])) for link in links]
    if refs:
        await join_project_resources(session, user_id=user_id, project_id=project_id, refs=refs)


async def add_resources(session, *, user_id, project_id, reminder_id, body):
    project, task = await _task_scope(session, user_id, project_id, reminder_id, revision=body.base_revision, lock=True)
    if body.role == "result" and task.recurrence != "once":
        raise HTTPException(422, "Results belong to one-time actions, not recurring reminder templates")
    refs = list({(ref.resource_type, ref.resource_id): ref for ref in body.resources}.values())
    added = await join_project_resources(session, user_id=user_id, project_id=project_id, refs=refs)
    existing = list((await session.execute(select(TodoResource).where(TodoResource.reminder_id == reminder_id, TodoResource.role == body.role))).scalars())
    keys = {(link.resource_type, getattr(link, RESOURCE_COLUMNS[link.resource_type])) for link in existing}
    for ref in refs:
        if (ref.resource_type, ref.resource_id) not in keys:
            session.add(TodoResource(reminder_id=reminder_id, role=body.role, resource_type=ref.resource_type,
                reason=ref.reason, **{RESOURCE_COLUMNS[ref.resource_type]: ref.resource_id}))
            added += 1
    if added:
        projects._advance(project)
    await session.commit()
    return await list_resources(session, user_id=user_id, project_id=project_id, reminder_id=reminder_id)


async def remove_resource(session, *, user_id, project_id, reminder_id, link_id, base_revision):
    project, _task = await _task_scope(session, user_id, project_id, reminder_id, revision=base_revision, lock=True)
    link = (await session.execute(select(TodoResource).where(TodoResource.id == link_id, TodoResource.reminder_id == reminder_id))).scalar_one_or_none()
    if link is None:
        raise HTTPException(404, "Task resource link not found")
    await session.delete(link)
    projects._advance(project)
    await session.commit()
    return await list_resources(session, user_id=user_id, project_id=project_id, reminder_id=reminder_id)
