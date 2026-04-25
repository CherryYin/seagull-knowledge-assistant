import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import async_session
from pkg.models.chat_session import ChatSession
from pkg.models.note import Note
from pkg.models.source import Source
from pkg.models.user import User
from pkg.schemas.action import ActionRequest, ActionResponse
from pkg.services.action_agent import create_action_agent, current_user_id
from pkg.services.activity import log_activity
from pkg.services.skills import expand_skill, load_skills_merged, parse_skill_invocation
from pkg.services.stats import increment_stats_mixed

logger = logging.getLogger(__name__)

router = APIRouter()

_DOWNLOAD_LINK_RE = re.compile(r"下载链接:\s*(https?://\S+)")
_REFERENCE_RE = re.compile(r"\[来源[：:]\s*((?:note|src|source)-[^\]]+)\]")
_WEB_REF_RE = re.compile(r"\[网络[：:]\s*([^\]]+)\]\((https?://[^)]+)\)")


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
    user_id: str | None = None,
) -> None:
    """Persist updated messages to the chat session."""
    async with async_session() as db:
        obj = await db.get(ChatSession, session_id)
        if obj is None:
            obj = ChatSession(id=session_id, user_id=user_id or "", title=title, messages=messages)
            db.add(obj)
        else:
            obj.title = title
            obj.messages = messages
        await db.commit()


def _make_message_dict(role: str, content: str, metadata: dict | None = None) -> dict:
    msg = {
        "id": f"msg-{uuid.uuid4()}",
        "role": role,
        "content": content,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if metadata:
        msg["metadata"] = metadata
    return msg


def _extract_document_metadata(text: str) -> dict | None:
    """Parse assistant response text for generated document download links.

    Returns metadata dict with documents list, or None if no documents found.
    """
    matches = _DOWNLOAD_LINK_RE.findall(text)
    if not matches:
        return None
    documents = []
    for url in matches:
        parsed = urlparse(url)
        # Extract the OSS object key from the URL path (e.g., /knowledge-graph/exports/doc.docx)
        path_parts = parsed.path.lstrip("/").split("/", 1)
        object_key = path_parts[1] if len(path_parts) > 1 else path_parts[0]
        filename = unquote(object_key.rsplit("/", 1)[-1])
        fmt = filename.rsplit(".", 1)[-1] if "." in filename else "unknown"
        # Build permanent storage URI instead of using the presigned URL
        bucket = settings.MINIO_BUCKET
        storage_uri = f"minio://{bucket}/{object_key}"
        documents.append({
            "storage_uri": storage_uri,
            "format": fmt,
            "filename": filename,
        })
    return {"documents": documents}


def _derive_title(messages: list[dict]) -> str:
    for msg in messages:
        if msg.get("role") == "user" and msg.get("content", "").strip():
            text = msg["content"].replace("\n", " ").strip()
            return text[:40] + "..." if len(text) > 40 else text
    return "New Session"


async def _track_references(text: str) -> None:
    """Parse [来源: xxx-id] references from agent output and increment reference_count."""
    refs = _REFERENCE_RE.findall(text)
    if not refs:
        return
    items: list[tuple[str, str]] = []
    for ref_id in set(refs):
        ref_id = ref_id.strip()
        if ref_id.startswith("note-"):
            items.append((ref_id, "note"))
        elif ref_id.startswith("source-"):
            # Normalize "source-xxx" to "src-xxx" to match DB IDs
            items.append(("src-" + ref_id[len("source-"):], "source"))
        elif ref_id.startswith("src-"):
            items.append((ref_id, "source"))
    await increment_stats_mixed(items, "reference_count")


async def _extract_references(text: str) -> list[dict] | None:
    """Extract citation IDs and web URLs from agent text, return references list."""
    results: list[dict] = []

    # Knowledge base references: [来源: note-xxx] / [来源: src-xxx]
    kb_refs = _REFERENCE_RE.findall(text)
    if kb_refs:
        normalized: dict[str, str] = {}  # id -> type
        for ref_id in set(kb_refs):
            ref_id = ref_id.strip()
            if ref_id.startswith("note-"):
                normalized[ref_id] = "note"
            elif ref_id.startswith("source-"):
                normalized["src-" + ref_id[len("source-"):]] = "source"
            elif ref_id.startswith("src-"):
                normalized[ref_id] = "source"
        if normalized:
            async with async_session() as db:
                for item_id, item_type in normalized.items():
                    if item_type == "note":
                        note = await db.get(Note, item_id)
                        results.append({"id": item_id, "type": "note", "title": note.title if note else item_id})
                    else:
                        source = await db.get(Source, item_id)
                        results.append({"id": item_id, "type": "source", "title": source.title if source else item_id})

    # Web references: [网络: title](url)
    web_refs = _WEB_REF_RE.findall(text)
    for title, url in web_refs:
        results.append({"id": url, "type": "web", "title": title.strip()})

    return results if results else None


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
async def execute_action(body: ActionRequest, user: User = Depends(get_current_user)):
    current_user_id.set(user.id)
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

    await log_activity(user.id, "chat", {"task": body.task[:200], "session_id": session_id})
    await _track_references(result_text)

    if session_id:
        db_messages.append(_make_message_dict("user", body.task))
        meta = _extract_document_metadata(result_text) or {}
        refs = await _extract_references(result_text)
        if refs:
            meta["references"] = refs
        db_messages.append(_make_message_dict("assistant", result_text, metadata=meta or None))
        await _save_session_messages(session_id, _derive_title(db_messages), db_messages, user_id=user.id)

    return ActionResponse(
        result=result_text,
        stop_reason=result.stop_reason or "end_turn",
        session_id=session_id,
    )


def _sse(event_type: str, data: dict | str) -> str:
    """Format a single SSE frame."""
    payload = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
    return f"event: {event_type}\ndata: {payload}\n\n"


@router.post("/action/stream")
async def execute_action_stream(body: ActionRequest, user: User = Depends(get_current_user)):
    current_user_id.set(user.id)
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
        current_tool: str | None = None
        try:
            async for event in agent.stream_async(task):
                # Detect tool-use start from contentBlockStart
                block_start = (
                    event.get("event", {})
                    .get("contentBlockStart", {})
                    .get("start", {})
                    .get("toolUse")
                )
                if block_start:
                    tool_name = block_start.get("name", "unknown")
                    # Close previous tool step if any
                    if current_tool:
                        yield _sse("step", {"tool": current_tool, "status": "done"})
                    current_tool = tool_name
                    if tool_name != "ask_human":
                        yield _sse("step", {"tool": tool_name, "status": "running"})

                # Text content
                if "data" in event:
                    text = event["data"]
                    collected_chunks.append(text)
                    yield _sse("content", {"text": text})

                # Detect ask_human tool result in the stream
                tool_use_data = event.get("current_tool_use", {})
                if tool_use_data.get("name") == "ask_human" and "input" in tool_use_data:
                    tool_input = tool_use_data["input"]
                    if isinstance(tool_input, dict):
                        question = tool_input.get("question", "")
                    elif isinstance(tool_input, str):
                        # Sometimes input arrives as a raw JSON string
                        try:
                            question = json.loads(tool_input).get("question", tool_input)
                        except (json.JSONDecodeError, AttributeError):
                            question = tool_input
                    else:
                        question = ""
                    if question:
                        yield _sse("ask_human", {"question": question})

        except Exception:
            logger.exception("Agent stream failed")
            yield _sse("error", {"message": "Agent encountered an error. Please try again."})

        # Close last tool step
        if current_tool:
            yield _sse("step", {"tool": current_tool, "status": "done"})

        yield _sse("done", {"session_id": session_id or ""})

        # Persist to DB after stream completes
        if session_id:
            full_response = "".join(collected_chunks)
            await _track_references(full_response)
            meta = _extract_document_metadata(full_response) or {}
            refs = await _extract_references(full_response)
            if refs:
                meta["references"] = refs
            db_messages.append(_make_message_dict("user", body.task))
            db_messages.append(_make_message_dict("assistant", full_response, metadata=meta or None))
            await _save_session_messages(
                session_id, _derive_title(db_messages), db_messages, user_id=user.id
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
