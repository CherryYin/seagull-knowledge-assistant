"""Daily summarizer — consolidates temporary notes into daily summary memory.

Runs as an asyncio background task in the FastAPI lifespan. Collects notes with
status="temporary", sends their content to the LLM for summarization, creates or
updates a daily summary Note, writes a global/day MemoryNode, and archives the
original temporary notes.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from pkg.db import async_session
from pkg.models.category import Category
from pkg.models.memory import MemoryNode
from pkg.models.note import Note, NoteEmbedding
from pkg.models.user import User
from pkg.services.embedding import get_embedding_service
from pkg.services.memory_tree import upsert_memory_embedding
from pkg.services.storage import get_storage_service

logger = logging.getLogger(__name__)

_SUMMARY_SYSTEM_PROMPT = """\
你是一个知识整理助手。请将以下多条临时笔记整理总结为一篇结构化的每日知识摘要。

要求：
1. 提炼关键主题和洞见，去除冗余
2. 按主题分类组织，使用清晰的标题层级
3. 保留重要的具体信息（数据、结论、决策）
4. 标注来源笔记的原始标题，方便回溯
5. 输出 markdown 格式
"""


def _utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _summary_title(today: str) -> str:
    return f"Daily Summary - {today}"


def _note_id(user_id: str, today: str) -> str:
    return f"note-{today}-{user_id[:8]}-daily-summary"


def _memory_node_id(user_id: str, today: str) -> str:
    return f"mem-global-day-{today}-{user_id[:8]}"


async def summarize_temporary_notes(user_id: str | None = None) -> str | None:
    """Collect temporary notes, summarize with LLM, and write Note + MemoryNode.

    If user_id is provided, only summarizes that user's temporary notes. If it is
    omitted, all active users with temporary notes are processed and the first
    created note id is returned for backward compatibility.
    """
    if user_id:
        return await _summarize_user_temporary_notes(user_id)

    note_ids = await summarize_all_users_temporary_notes()
    return note_ids[0] if note_ids else None


async def summarize_all_users_temporary_notes() -> list[str]:
    """Summarize temporary notes for every active user that has any."""
    async with async_session() as session:
        result = await session.execute(
            select(User.id).join(Note, Note.user_id == User.id).where(
                User.is_active,
                Note.status == "temporary",
            ).distinct()
        )
        user_ids = [row[0] for row in result]

    note_ids: list[str] = []
    for candidate_user_id in user_ids:
        try:
            note_id = await _summarize_user_temporary_notes(candidate_user_id)
            if note_id:
                note_ids.append(note_id)
        except Exception:
            logger.exception("Daily summarization failed for user %s", candidate_user_id)
    return note_ids


async def _summarize_user_temporary_notes(user_id: str) -> str | None:
    """Summarize one user's temporary notes into a daily Note and MemoryNode."""
    async with async_session() as session:
        stmt = select(Note).where(Note.user_id == user_id, Note.status == "temporary")
        result = await session.execute(stmt)
        temp_notes = list(result.scalars())

    if not temp_notes:
        logger.info("No temporary notes to summarize for user %s", user_id)
        return None

    logger.info("Summarizing %d temporary notes for user %s", len(temp_notes), user_id)

    parts: list[str] = []
    for note in temp_notes:
        created = note.created_at.strftime("%Y-%m-%d %H:%M") if note.created_at else "unknown"
        parts.append(f"## {note.title} ({created})\nID: {note.id}\n\n{note.content or '(empty)'}\n")
    combined = "\n---\n\n".join(parts)

    from pkg.services.llm import create_async_client
    client, model = create_async_client()

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": combined},
            ],
        )
        summary = response.choices[0].message.content or ""
    except Exception:
        logger.exception("LLM summarization failed for user %s", user_id)
        return None

    if not summary.strip():
        logger.warning("LLM returned empty summary for user %s", user_id)
        return None

    today = _utc_today()
    note_id = _note_id(user_id, today)
    memory_node_id = _memory_node_id(user_id, today)
    title = _summary_title(today)
    temp_note_ids = [note.id for note in temp_notes]
    derived_source_ids = _merge_unique([source_id for note in temp_notes for source_id in note.source_ids])

    storage = get_storage_service()
    object_key = storage.build_object_key("notes", note_id, "note.md")
    storage_uri = await storage.upload_bytes(
        object_key=object_key,
        data=summary.encode("utf-8"),
        content_type="text/markdown",
    )

    async with async_session() as session:
        cat_result = await session.execute(select(Category).where(Category.name == "general"))
        default_cat = cat_result.scalar()
        default_category_id = default_cat.id if default_cat else 1

        existing = await session.get(Note, note_id)
        if existing:
            existing.content = summary
            existing.file_path = storage_uri
            existing.word_count = len(summary.split())
            existing.source_ids = derived_source_ids
        else:
            note = Note(
                id=note_id,
                user_id=user_id,
                category_id=default_category_id,
                title=title,
                note_type="inbox",
                domains=["daily-summary"],
                tags=["daily-summary", "auto-generated", "global-memory"],
                content=summary,
                status="seed",
                confidence="medium",
                source_ids=derived_source_ids,
                file_path=storage_uri,
                word_count=len(summary.split()),
            )
            session.add(note)

        await _upsert_note_embedding(session, note_id, title, summary)
        await _upsert_daily_memory_node(
            session=session,
            node_id=memory_node_id,
            user_id=user_id,
            today=today,
            title=title,
            summary=summary,
            derived_note_ids=temp_note_ids,
            derived_source_ids=derived_source_ids,
        )

        for temp_note in temp_notes:
            obj = await session.get(Note, temp_note.id)
            if obj:
                obj.status = "archived"

        try:
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    logger.info("Created daily summary note %s and memory node %s", note_id, memory_node_id)
    return note_id


async def _upsert_note_embedding(session, note_id: str, title: str, summary: str) -> None:
    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(title)
        abstract_vec = await emb_svc.embed_text(summary[:8000])
        emb_row = await session.get(NoteEmbedding, note_id)
        if emb_row:
            emb_row.title_vec = title_vec
            emb_row.abstract_vec = abstract_vec
        else:
            session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))
    except Exception:
        logger.error("Embedding generation failed for daily note %s", note_id, exc_info=True)


async def _upsert_daily_memory_node(
    *,
    session,
    node_id: str,
    user_id: str,
    today: str,
    title: str,
    summary: str,
    derived_note_ids: list[str],
    derived_source_ids: list[str],
) -> None:
    existing = await session.get(MemoryNode, node_id)
    if existing:
        existing.title = title
        existing.summary = _first_non_empty_line(summary)
        existing.content = summary
        existing.derived_from_notes = derived_note_ids
        existing.derived_from_sources = derived_source_ids
        existing.metadata_ = {"date": today, "source": "daily_summarizer"}
        await upsert_memory_embedding(session, existing)
    else:
        node = MemoryNode(
            id=node_id,
            user_id=user_id,
            node_type="global",
            scope_id=today,
            level="day",
            title=title,
            summary=_first_non_empty_line(summary),
            content=summary,
            child_node_ids=[],
            derived_from_notes=derived_note_ids,
            derived_from_sources=derived_source_ids,
            derived_from_chunks=[],
            metadata_={"date": today, "source": "daily_summarizer"},
            confidence_score=None,
        )
        session.add(node)
        await upsert_memory_embedding(session, node)


def _first_non_empty_line(value: str) -> str:
    for line in value.splitlines():
        cleaned = line.strip().lstrip("# ").strip()
        if cleaned:
            return cleaned[:500]
    return "Daily summary"


def _merge_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged
