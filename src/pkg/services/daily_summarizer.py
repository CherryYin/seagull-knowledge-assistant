"""Daily summarizer — consolidates temporary notes into a daily summary note.

Runs as an asyncio background task in the FastAPI lifespan. Collects all notes
with status="temporary", sends their content to the LLM for summarization,
creates a new summary note, and archives the originals.
"""
import logging
from datetime import datetime, timezone

from openai import AsyncOpenAI
from sqlalchemy import select

from pkg.config import settings
from pkg.db import async_session
from pkg.models.category import Category
from pkg.models.note import Note, NoteEmbedding
from pkg.services.embedding import get_embedding_service
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


async def summarize_temporary_notes() -> str | None:
    """Collect temporary notes, summarize with LLM, create a daily summary note.

    Returns the new note ID on success, or None if there are no temporary notes.
    """
    async with async_session() as session:
        stmt = select(Note).where(Note.status == "temporary")
        result = await session.execute(stmt)
        temp_notes = list(result.scalars())

    if not temp_notes:
        logger.info("No temporary notes to summarize")
        return None

    logger.info("Summarizing %d temporary notes", len(temp_notes))

    # Build combined text for LLM
    parts: list[str] = []
    for note in temp_notes:
        created = note.created_at.strftime("%Y-%m-%d %H:%M") if note.created_at else "unknown"
        parts.append(f"## {note.title} ({created})\n\n{note.content or '(empty)'}\n")
    combined = "\n---\n\n".join(parts)

    # Call LLM for summarization
    if settings.LLM_PROVIDER == "azure":
        client = AsyncOpenAI(
            base_url=f"{settings.AZURE_OPENAI_ENDPOINT}/openai/deployments/{settings.AZURE_OPENAI_DEPLOYMENT}",
            api_key=settings.AZURE_OPENAI_API_KEY,
            default_headers={"api-version": settings.AZURE_OPENAI_API_VERSION},
        )
        model = settings.AZURE_OPENAI_DEPLOYMENT
    else:
        client = AsyncOpenAI(
            base_url=settings.QWEN_API_BASE,
            api_key=settings.QWEN_API_KEY,
        )
        model = settings.QWEN_MODEL

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
        logger.exception("LLM summarization failed")
        return None

    if not summary.strip():
        logger.warning("LLM returned empty summary")
        return None

    # Create the summary note
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    note_id = f"note-{today}-daily-summary"
    title = f"Daily Summary - {today}"

    storage = get_storage_service()
    object_key = storage.build_object_key("notes", note_id, "note.md")
    storage_uri = storage.upload_bytes(
        object_key=object_key,
        data=summary.encode("utf-8"),
        content_type="text/markdown",
    )

    async with async_session() as session:
        # Resolve default category
        cat_result = await session.execute(select(Category).where(Category.name == "general"))
        default_cat = cat_result.scalar()
        default_category_id = default_cat.id if default_cat else 1

        # Create or update the daily summary note (idempotent on re-run)
        existing = await session.get(Note, note_id)
        if existing:
            existing.content = summary
            existing.file_path = storage_uri
            existing.word_count = len(summary.split())
        else:
            note = Note(
                id=note_id,
                category_id=default_category_id,
                title=title,
                note_type="inbox",
                domains=["daily-summary"],
                tags=["daily-summary", "auto-generated"],
                content=summary,
                status="seed",
                confidence="medium",
                source_ids=[],
                file_path=storage_uri,
                word_count=len(summary.split()),
            )
            session.add(note)

            emb_svc = get_embedding_service()
            title_vec = emb_svc.embed_text(title)
            abstract_vec = emb_svc.embed_text(summary[:500])
            session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))

        # Archive processed temporary notes
        for temp_note in temp_notes:
            obj = await session.get(Note, temp_note.id)
            if obj:
                obj.status = "archived"

        await session.commit()

    logger.info("Created daily summary note: %s (from %d temp notes)", note_id, len(temp_notes))
    return note_id
