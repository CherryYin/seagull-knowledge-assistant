import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from pkg.config import settings
from pkg.db import async_session
from pkg.models.chat_session import ChatSession
from pkg.schemas.action import ActionRequest, ActionResponse
from pkg.services.action_agent import create_action_agent
from pkg.services.skills import expand_skill, load_skills_merged, parse_skill_invocation

logger = logging.getLogger(__name__)

router = APIRouter()


def _normalize_strands_message(msg: dict[str, Any]) -> dict[str, Any]:
    """Map API-style {role, content: str} to Strands Message with list of text blocks."""
    role = msg.get("role", "user")
    content = msg.get("content")
    if isinstance(content, str):
        blocks: list[dict[str, Any]] = [{"text": content}]
    elif isinstance(content, list):
        blocks = []
        for block in content:
            if isinstance(block, str):
                blocks.append({"text": block})
            else:
                blocks.append(block)
    else:
        blocks = [{"text": "" if content is None else str(content)}]
    return {"role": role, "content": blocks}


async def _load_session_history(session_id: str) -> tuple[ChatSession | None, list[dict]]:
    """Load conversation history from a persisted chat session."""
    async with async_session() as db:
        obj = await db.get(ChatSession, session_id)
        if obj is None:
            return None, []
        return obj, list(obj.messages or [])


async def _save_session_messages(
    session_id: str,
    title: str,
    messages: list[dict],
) -> None:
    """Persist updated messages to the chat session."""
    async with async_session() as db:
        obj = await db.get(ChatSession, session_id)
        if obj is None:
            obj = ChatSession(id=session_id, title=title, messages=messages)
            db.add(obj)
        else:
            obj.title = title
            obj.messages = messages
        await db.commit()


def _make_message_dict(role: str, content: str) -> dict:
    return {
        "id": f"msg-{uuid.uuid4()}",
        "role": role,
        "content": content,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def _derive_title(messages: list[dict]) -> str:
    for msg in messages:
        if msg.get("role") == "user" and msg.get("content", "").strip():
            text = msg["content"].replace("\n", " ").strip()
            return text[:40] + "..." if len(text) > 40 else text
    return "New Session"


async def _try_expand_skill(task: str) -> str:
    """If task starts with /skill-name, expand it. Otherwise return as-is."""
    invocation = parse_skill_invocation(task)
    if invocation is None:
        return task
    skill_name, args = invocation
    skills = await load_skills_merged(settings.skills_dir)
    for skill in skills:
        if skill.name == skill_name:
            return expand_skill(skill, args)
    return task


@router.post("/action", response_model=ActionResponse)
async def execute_action(body: ActionRequest):
    agent = await create_action_agent(callback_handler=None)

    session_id = body.session_id
    db_messages: list[dict] = []

    if session_id:
        _, db_messages = await _load_session_history(session_id)
        for msg in db_messages:
            agent.messages.append(_normalize_strands_message(msg))
    elif body.conversation_history:
        for msg in body.conversation_history:
            agent.messages.append(_normalize_strands_message(msg))

    task = await _try_expand_skill(body.task)

    try:
        result = await agent.invoke_async(task)
    except Exception as exc:
        logger.exception("Agent invocation failed")
        raise HTTPException(status_code=503, detail=f"Agent error: {exc}")

    result_text = result.message.get("content", [{}])[0].get("text", str(result.message))

    if session_id:
        db_messages.append(_make_message_dict("user", body.task))
        db_messages.append(_make_message_dict("assistant", result_text))
        await _save_session_messages(session_id, _derive_title(db_messages), db_messages)

    return ActionResponse(
        result=result_text,
        stop_reason=result.stop_reason or "end_turn",
        session_id=session_id,
    )


@router.post("/action/stream")
async def execute_action_stream(body: ActionRequest):
    agent = await create_action_agent(callback_handler=None)

    session_id = body.session_id
    db_messages: list[dict] = []

    if session_id:
        _, db_messages = await _load_session_history(session_id)
        for msg in db_messages:
            agent.messages.append(_normalize_strands_message(msg))
    elif body.conversation_history:
        for msg in body.conversation_history:
            agent.messages.append(_normalize_strands_message(msg))

    task = await _try_expand_skill(body.task)
    collected_chunks: list[str] = []

    async def event_generator():
        try:
            async for event in agent.stream_async(task):
                if "data" in event:
                    collected_chunks.append(event["data"])
                    yield event["data"]
        except Exception:
            logger.exception("Agent stream failed")
            yield "\n\n[Error: Agent encountered an error. Please try again.]"

    response = StreamingResponse(event_generator(), media_type="text/plain")

    if session_id:
        original_body_iterator = response.body_iterator

        async def wrapped_iterator():
            async for chunk in original_body_iterator:
                yield chunk
            # After stream completes, persist to DB
            full_response = "".join(collected_chunks)
            db_messages.append(_make_message_dict("user", body.task))
            db_messages.append(_make_message_dict("assistant", full_response))
            await _save_session_messages(
                session_id, _derive_title(db_messages), db_messages
            )

        response.body_iterator = wrapped_iterator()

    return response
