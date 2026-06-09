import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import async_session
from pkg.models.chat_session import ChatSession
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.user import User
from pkg.schemas.action import ActionRequest, ActionResponse
from pkg.services.orchestration.action_agent import create_action_agent, current_run_id, current_user_id
from pkg.services.cross_cutting.activity import log_activity
from pkg.services.cross_cutting.agent_runs import (
    add_run_event,
    complete_run,
    fail_run,
    start_run,
    update_run_status,
)
from pkg.services.cross_cutting.skills import expand_skill, load_skills_merged, parse_skill_invocation
from pkg.services.cross_cutting.stats import increment_stats_mixed

logger = logging.getLogger(__name__)

router = APIRouter()

_DOWNLOAD_LINK_RE = re.compile(r"下载链接:\s*(https?://\S+)")
_WRITING_NOTE_RE = re.compile(r"Writing ID:\s*(note-[^\s]+)")
_REFERENCE_RE = re.compile(r"\[来源[：:]\s*((?:note|src|source)-[^\]]+)\]")
_WEB_REF_RE = re.compile(r"\[网络[：:]\s*([^\]]+)\]\((https?://[^)]+)\)")


def _status_for_tool(tool_name: str) -> tuple[str, str]:
    if tool_name in {"search_memory", "list_related_memory"}:
        return "searching", "memory_searched"
    if tool_name == "read_memory_node":
        return "reading", "memory_read"
    if tool_name == "create_memory_from_conversation":
        return "writing", "memory_created"
    if tool_name == "search_knowledge":
        return "searching", "knowledge_searched"
    if tool_name == "read_note":
        return "reading", "note_read"
    if tool_name == "read_source":
        return "reading", "source_read"
    if tool_name == "process_document":
        return "writing", "document_generated"
    return "tool_calling", "tool_started"


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


async def _load_session_history(session_id: str, user_id: str) -> tuple[ChatSession | None, list[dict]]:
    """Load conversation history from a persisted chat session, scoped to the requesting user."""
    async with async_session() as db:
        obj = await db.get(ChatSession, session_id)
        if obj is None:
            return None, []
        if obj.user_id != user_id:
            return None, []
        return obj, list(obj.messages or [])


async def _save_session_messages(
    session_id: str,
    title: str,
    messages: list[dict],
    user_id: str | None = None,
    profile_id: str | None = None,
) -> None:
    """Persist updated messages to the chat session."""
    async with async_session() as db:
        obj = await db.get(ChatSession, session_id)
        if obj is None:
            obj = ChatSession(id=session_id, user_id=user_id or "", title=title, messages=messages, profile_id=profile_id)
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
        path_parts = parsed.path.lstrip("/").split("/", 1)
        object_key = path_parts[1] if len(path_parts) > 1 else path_parts[0]
        filename = unquote(object_key.rsplit("/", 1)[-1])
        fmt = filename.rsplit(".", 1)[-1] if "." in filename else "unknown"
        bucket = settings.MINIO_BUCKET
        storage_uri = f"minio://{bucket}/{object_key}"
        documents.append({
            "storage_uri": storage_uri,
            "format": fmt,
            "filename": filename,
        })
    metadata = {"documents": documents}
    writing_match = _WRITING_NOTE_RE.search(text)
    if writing_match:
        metadata["writing_note_id"] = writing_match.group(1)
    return metadata


def _collect_tool_result_links(messages: list) -> str:
    """Extract text containing download links from tool results in agent conversation."""
    parts: list[str] = []
    for msg in messages:
        if msg.get("role") != "user":
            continue
        for block in msg.get("content", []):
            if not isinstance(block, dict) or "toolResult" not in block:
                continue
            for item in block["toolResult"].get("content", []):
                if isinstance(item, dict) and "text" in item:
                    if _DOWNLOAD_LINK_RE.search(item["text"]):
                        parts.append(item["text"])
    return "\n".join(parts)


def _extract_generated_document(messages: list) -> dict | None:
    """Extract document content from process_document tool input in agent messages.

    Returns {"content": ..., "title": ...} or None if no document tool was used.
    """
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        for block in msg.get("content", []):
            if not isinstance(block, dict) or "toolUse" not in block:
                continue
            tool_use = block["toolUse"]
            if tool_use.get("name") != "process_document":
                continue
            tool_input = tool_use.get("input", {})
            content = tool_input.get("content", "")
            filename = tool_input.get("filename", "")
            if content:
                title = filename.replace("-", " ").replace("_", " ").strip() if filename else None
                return {"content": content, "title": title}
    return None


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


async def _load_profile(profile_id: str | None, user_id: str):
    """Load an AgentProfile by explicit ID or fall back to user's default profile."""
    from sqlalchemy import select

    from pkg.models.agent_profile import AgentProfile

    async with async_session() as db:
        if profile_id:
            profile = await db.get(AgentProfile, profile_id)
            if not profile or profile.user_id != user_id:
                raise HTTPException(status_code=404, detail="Profile not found")
            return profile
        result = await db.execute(
            select(AgentProfile).where(
                AgentProfile.user_id == user_id,
                AgentProfile.is_default.is_(True),
            )
        )
        return result.scalar_one_or_none()


@router.post("/action", response_model=ActionResponse)
async def execute_action(body: ActionRequest, user: User = Depends(get_current_user)):
    current_user_id.set(user.id)
    profile = await _load_profile(body.profile_id, user.id)
    task = await _try_expand_skill(body.task)
    run = await start_run(
        user_id=user.id,
        profile_id=profile.id if profile else body.profile_id,
        agent_type=profile.agent_type if profile else "action",
        task=body.task,
    )
    current_run_id.set(run.id)
    await add_run_event(run.id, user.id, "task_received", "Task received", detail=body.task)
    await add_run_event(
        run.id,
        user.id,
        "profile_loaded",
        "Profile loaded" if profile else "Default agent loaded",
        detail=profile.name if profile else None,
        metadata={"profile_id": profile.id, "agent_type": profile.agent_type} if profile else None,
    )
    try:
        agent = await create_action_agent(
            callback_handler=None, profile=profile,
            model_id=body.model_id, provider_id=body.provider_id,
        )
    except Exception as exc:
        logger.exception("Agent creation failed")
        await fail_run(run.id, str(exc))
        raise HTTPException(status_code=503, detail=f"Agent error: {exc}")

    session_id = body.session_id
    db_messages: list[dict] = []

    if session_id:
        _, db_messages = await _load_session_history(session_id, user.id)
        for msg in db_messages:
            agent.messages.append(_normalize_strands_message(msg))
    elif body.conversation_history:
        for msg in body.conversation_history:
            agent.messages.append(_normalize_strands_message(msg))

    try:
        await update_run_status(run.id, "thinking")
        await add_run_event(run.id, user.id, "state_changed", "Thinking")
        result = await agent.invoke_async(task)
    except Exception as exc:
        logger.exception("Agent invocation failed")
        await fail_run(run.id, str(exc))
        raise HTTPException(status_code=503, detail=f"Agent error: {exc}")

    result_text = result.message.get("content", [{}])[0].get("text", str(result.message))
    await complete_run(run.id, result_preview=result_text)

    await log_activity(user.id, "chat", {"task": body.task[:200], "session_id": session_id})
    await _track_references(result_text)

    if session_id:
        db_messages.append(_make_message_dict("user", body.task))
        tool_links = _collect_tool_result_links(agent.messages)
        combined_text = result_text + "\n" + tool_links if tool_links else result_text
        meta = _extract_document_metadata(combined_text) or {}
        doc_info = _extract_generated_document(agent.messages)
        if doc_info:
            meta["has_generated_document"] = True
            meta["document_content"] = doc_info["content"]
            if doc_info["title"]:
                meta["document_title"] = doc_info["title"]
        refs = await _extract_references(result_text)
        if refs:
            meta["references"] = refs
        db_messages.append(_make_message_dict("assistant", result_text, metadata=meta or None))
        await _save_session_messages(session_id, _derive_title(db_messages), db_messages, user_id=user.id, profile_id=body.profile_id)

    return ActionResponse(
        result=result_text,
        stop_reason=result.stop_reason or "end_turn",
        session_id=session_id,
        run_id=run.id,
    )


def _sse(event_type: str, data: dict | str) -> str:
    """Format a single SSE frame."""
    payload = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
    return f"event: {event_type}\ndata: {payload}\n\n"


@router.post("/action/stream")
async def execute_action_stream(body: ActionRequest, request: Request, user: User = Depends(get_current_user)):
    current_user_id.set(user.id)
    profile = await _load_profile(body.profile_id, user.id)
    task = await _try_expand_skill(body.task)
    run = await start_run(
        user_id=user.id,
        profile_id=profile.id if profile else body.profile_id,
        agent_type=profile.agent_type if profile else "action",
        task=body.task,
    )
    current_run_id.set(run.id)
    await add_run_event(run.id, user.id, "task_received", "Task received", detail=body.task)
    await add_run_event(
        run.id,
        user.id,
        "profile_loaded",
        "Profile loaded" if profile else "Default agent loaded",
        detail=profile.name if profile else None,
        metadata={"profile_id": profile.id, "agent_type": profile.agent_type} if profile else None,
    )
    try:
        agent = await create_action_agent(
            callback_handler=None, profile=profile,
            model_id=body.model_id, provider_id=body.provider_id,
        )
    except Exception as exc:
        logger.exception("Agent creation failed")
        await fail_run(run.id, str(exc))
        raise HTTPException(status_code=503, detail=f"Agent error: {exc}")

    session_id = body.session_id
    db_messages: list[dict] = []

    if session_id:
        _, db_messages = await _load_session_history(session_id, user.id)
        for msg in db_messages:
            agent.messages.append(_normalize_strands_message(msg))
    elif body.conversation_history:
        for msg in body.conversation_history:
            agent.messages.append(_normalize_strands_message(msg))

    collected_chunks: list[str] = []

    async def event_generator():
        current_tool: str | None = None
        ask_human_emitted = False
        failed = False
        disconnected = False
        writing_started = False
        yield _sse("run", {"run_id": run.id})
        await update_run_status(run.id, "thinking")
        await add_run_event(run.id, user.id, "state_changed", "Thinking")
        agent_stream = agent.stream_async(task)
        try:
            async for event in agent_stream:
                if await request.is_disconnected():
                    disconnected = True
                    logger.info("Agent stream disconnected: run_id=%s", run.id)
                    break
                # Detect tool-use start from contentBlockStart
                block_start = (
                    event.get("event", {})
                    .get("contentBlockStart", {})
                    .get("start", {})
                    .get("toolUse")
                )
                if block_start:
                    tool_name = block_start.get("name", "unknown")
                    if current_tool:
                        yield _sse("step", {"tool": current_tool, "status": "done"})
                        await add_run_event(
                            run.id,
                            user.id,
                            "tool_finished",
                            f"Tool finished: {current_tool}",
                            metadata={"tool": current_tool},
                        )
                    current_tool = tool_name
                    ask_human_emitted = False
                    if tool_name != "ask_human":
                        status, event_type = _status_for_tool(tool_name)
                        await update_run_status(run.id, status)
                        await add_run_event(
                            run.id,
                            user.id,
                            event_type,
                            f"Tool started: {tool_name}",
                            metadata={"tool": tool_name},
                        )
                        yield _sse("step", {"tool": tool_name, "status": "running"})

                # Text content
                if "data" in event:
                    text = event["data"]
                    collected_chunks.append(text)
                    if not writing_started:
                        writing_started = True
                        await update_run_status(run.id, "writing")
                        await add_run_event(run.id, user.id, "state_changed", "Writing response")
                    yield _sse("content", {"text": text})

                # Detect ask_human tool input (emit once per call)
                if not ask_human_emitted:
                    tool_use_data = event.get("current_tool_use", {})
                    if tool_use_data.get("name") == "ask_human" and "input" in tool_use_data:
                        tool_input = tool_use_data["input"]
                        question = ""
                        options = None
                        if isinstance(tool_input, dict):
                            question = tool_input.get("question", "")
                            options = tool_input.get("options")
                        elif isinstance(tool_input, str):
                            try:
                                parsed = json.loads(tool_input)
                                question = parsed.get("question", "")
                                options = parsed.get("options")
                            except (json.JSONDecodeError, AttributeError):
                                pass
                        if question and len(question) > 10:
                            ask_human_emitted = True
                            evt: dict = {"question": question}
                            if options:
                                evt["options"] = options
                            yield _sse("ask_human", evt)

        except asyncio.CancelledError:
            disconnected = True
            logger.info("Agent stream cancelled by client: run_id=%s", run.id)
            raise
        except Exception:
            logger.exception("Agent stream failed")
            failed = True
            await fail_run(run.id, "Agent encountered an error. Please try again.")
            yield _sse("error", {"message": "Agent encountered an error. Please try again."})
        finally:
            await agent_stream.aclose()

        if disconnected:
            await fail_run(run.id, "Client disconnected before completion.")
            return

        # Close last tool step
        if current_tool:
            yield _sse("step", {"tool": current_tool, "status": "done"})
            await add_run_event(
                run.id,
                user.id,
                "tool_finished",
                f"Tool finished: {current_tool}",
                metadata={"tool": current_tool},
            )

        # Persist to DB before sending done so the frontend can refresh immediately
        if session_id and not disconnected:
            full_response = "".join(collected_chunks)
            await _track_references(full_response)
            tool_links = _collect_tool_result_links(agent.messages)
            scan_text = full_response + "\n" + tool_links if tool_links else full_response
            meta = _extract_document_metadata(scan_text) or {}
            doc_info = _extract_generated_document(agent.messages)
            if doc_info:
                meta["has_generated_document"] = True
                meta["document_content"] = doc_info["content"]
                if doc_info["title"]:
                    meta["document_title"] = doc_info["title"]
            refs = await _extract_references(full_response)
            if refs:
                meta["references"] = refs
            db_messages.append(_make_message_dict("user", body.task))
            db_messages.append(_make_message_dict("assistant", full_response, metadata=meta or None))
            await _save_session_messages(
                session_id, _derive_title(db_messages), db_messages, user_id=user.id, profile_id=body.profile_id
            )

        full_response = "".join(collected_chunks)
        if not failed:
            await complete_run(run.id, result_preview=full_response)

        yield _sse("done", {"session_id": session_id or "", "run_id": run.id})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
