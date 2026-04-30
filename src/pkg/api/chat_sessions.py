import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.chat_session import ChatSession
from pkg.models.user import User
from pkg.schemas.chat_session import (
    ChatSessionCreate,
    ChatSessionList,
    ChatSessionRead,
    ChatSessionUpdate,
)

router = APIRouter()


@router.post("", response_model=ChatSessionRead, status_code=201)
async def create_session(
    body: ChatSessionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    session_id = body.id or f"session-{uuid.uuid4()}"
    obj = ChatSession(
        id=session_id,
        user_id=user.id,
        title=body.title,
        messages=[m.model_dump() for m in body.messages],
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get("", response_model=ChatSessionList)
async def list_sessions(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    count_stmt = select(func.count()).select_from(ChatSession).where(ChatSession.user_id == user.id)
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(ChatSession)
        .where(ChatSession.user_id == user.id)
        .order_by(ChatSession.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    rows = await db.execute(stmt)
    items = list(rows.scalars())
    return ChatSessionList(items=items, total=total)


@router.get("/{session_id}", response_model=ChatSessionRead)
async def get_session_by_id(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(ChatSession, session_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    return obj


@router.patch("/{session_id}", response_model=ChatSessionRead)
async def update_session(
    session_id: str,
    body: ChatSessionUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(ChatSession, session_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")

    if body.title is not None:
        obj.title = body.title
    if body.messages is not None:
        obj.messages = [m.model_dump() for m in body.messages]

    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    obj = await db.get(ChatSession, session_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    await db.delete(obj)
    await db.commit()
