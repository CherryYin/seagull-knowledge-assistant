import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.note import Note
from pkg.models.memory import MemoryNode
from pkg.models.source import Source
from pkg.models.user import User
from pkg.models.wiki import WikiEmbedding, WikiPage, WikiPageMemory, WikiPageSource, WikiRecompileSuggestion
from pkg.schemas.wiki import (
    WikiCompileRequest,
    WikiFromMemoryRequest,
    WikiPageCreate,
    WikiPageList,
    WikiPageMemoryCreate,
    WikiPageMemoryRead,
    WikiPageRead,
    WikiPageSourceCreate,
    WikiPageSourceRead,
    WikiPageUpdate,
    WikiRecompileSuggestionList,
    WikiRecompileSuggestionRead,
    WikiSuggestionStatusUpdate,
    WikiSuggestRequest,
)
from pkg.services.embedding import get_embedding_service
from pkg.services.llm import create_async_client
from pkg.services.memory_retriever import format_memory_context, retrieve_for_wiki
from pkg.services.wiki_recompile import suggest_wiki_recompile_for_trigger

router = APIRouter()
logger = logging.getLogger(__name__)


def make_wiki_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    suffix = uuid.uuid4().hex[:8]
    slug = title[:40].lower().replace(" ", "-")
    return f"wiki-{slug}-{suffix}"


async def _upsert_wiki_embedding(session: AsyncSession, wiki: WikiPage) -> None:
    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(wiki.title)
        summary_vec = await emb_svc.embed_text(wiki.summary or wiki.title)
        content_vec = await emb_svc.embed_text(wiki.content or wiki.summary or wiki.title)
        emb_row = await session.get(WikiEmbedding, wiki.id)
        if emb_row:
            emb_row.title_vec = title_vec
            emb_row.summary_vec = summary_vec
            emb_row.content_vec = content_vec
        else:
            session.add(WikiEmbedding(
                wiki_id=wiki.id,
                title_vec=title_vec,
                summary_vec=summary_vec,
                content_vec=content_vec,
            ))
    except Exception:
        logger.error("Embedding generation failed for wiki %s", wiki.id, exc_info=True)


async def persist_wiki_page(*, session: AsyncSession, body: WikiPageCreate, user_id: str) -> WikiPage:
    wiki_id = make_wiki_id(body.title, body.id)
    wiki = WikiPage(
        id=wiki_id,
        user_id=user_id,
        title=body.title,
        page_type=body.page_type,
        summary=body.summary,
        content=body.content,
        domains=body.domains,
        tags=body.tags,
        derived_from_notes=body.derived_from_notes,
        derived_from_sources=body.derived_from_sources,
        open_questions=body.open_questions,
        confidence_score=body.confidence_score,
        last_compiled_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    session.add(wiki)
    await _upsert_wiki_embedding(session, wiki)
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    await session.refresh(wiki)
    return wiki


@router.post("", response_model=WikiPageRead, status_code=201)
async def create_wiki_page(
    body: WikiPageCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await persist_wiki_page(session=session, body=body, user_id=user.id)


@router.get("", response_model=WikiPageList)
async def list_wiki_pages(
    page_type: str | None = None,
    domain: str | None = None,
    tag: str | None = None,
    needs_recompile: bool | None = None,
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(WikiPage).where(WikiPage.user_id == user.id)
    count_stmt = select(func.count()).select_from(WikiPage).where(WikiPage.user_id == user.id)

    if page_type:
        stmt = stmt.where(WikiPage.page_type == page_type)
        count_stmt = count_stmt.where(WikiPage.page_type == page_type)
    if domain:
        stmt = stmt.where(WikiPage.domains.any(domain))
        count_stmt = count_stmt.where(WikiPage.domains.any(domain))
    if tag:
        stmt = stmt.where(WikiPage.tags.any(tag))
        count_stmt = count_stmt.where(WikiPage.tags.any(tag))
    if needs_recompile is not None:
        stmt = stmt.where(WikiPage.needs_recompile == needs_recompile)
        count_stmt = count_stmt.where(WikiPage.needs_recompile == needs_recompile)

    stmt = stmt.order_by(WikiPage.updated_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    return WikiPageList(items=list(rows.scalars()), total=total)


@router.get("/suggestions", response_model=WikiRecompileSuggestionList)
async def list_wiki_suggestions(
    status: str | None = "pending",
    wiki_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = (
        select(WikiRecompileSuggestion, WikiPage.title.label("wiki_title"))
        .join(WikiPage, WikiPage.id == WikiRecompileSuggestion.wiki_id)
        .where(WikiRecompileSuggestion.user_id == user.id)
    )
    count_stmt = select(func.count()).select_from(WikiRecompileSuggestion).where(
        WikiRecompileSuggestion.user_id == user.id
    )
    if status:
        stmt = stmt.where(WikiRecompileSuggestion.status == status)
        count_stmt = count_stmt.where(WikiRecompileSuggestion.status == status)
    if wiki_id:
        stmt = stmt.where(WikiRecompileSuggestion.wiki_id == wiki_id)
        count_stmt = count_stmt.where(WikiRecompileSuggestion.wiki_id == wiki_id)

    stmt = stmt.order_by(WikiRecompileSuggestion.created_at.desc()).offset(offset).limit(limit)
    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    items = []
    for suggestion, wiki_title in rows:
        item = WikiRecompileSuggestionRead.model_validate(suggestion)
        item.wiki_title = wiki_title
        items.append(item)
    return WikiRecompileSuggestionList(items=items, total=total)


@router.post("/suggestions", response_model=list[WikiRecompileSuggestionRead])
async def create_wiki_suggestions(
    body: WikiSuggestRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    suggestions = await suggest_wiki_recompile_for_trigger(
        session,
        user_id=user.id,
        trigger_type=body.trigger_type,
        trigger_id=body.trigger_id,
        limit=body.limit,
    )
    await session.commit()
    return [WikiRecompileSuggestionRead.model_validate(item) for item in suggestions]


@router.patch("/suggestions/{suggestion_id}", response_model=WikiRecompileSuggestionRead)
async def update_wiki_suggestion_status(
    suggestion_id: int,
    body: WikiSuggestionStatusUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    suggestion = await session.get(WikiRecompileSuggestion, suggestion_id)
    if not suggestion or suggestion.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki suggestion not found")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    suggestion.status = "rejected" if body.status == "dismissed" else body.status
    suggestion.reviewer_note = body.reviewer_note
    if suggestion.status in {"accepted", "rejected", "applied"}:
        suggestion.reviewed_at = now
    if suggestion.status == "applied":
        suggestion.applied_at = now

    wiki = await session.get(WikiPage, suggestion.wiki_id)
    if wiki and wiki.user_id == user.id:
        if suggestion.status == "accepted":
            wiki.needs_recompile = True
            wiki.stale_reason = suggestion.reason
            wiki.stale_triggered_at = wiki.stale_triggered_at or suggestion.created_at or now
        elif suggestion.status == "applied":
            wiki.needs_recompile = False
            wiki.stale_reason = None
            wiki.stale_triggered_at = None
            wiki.last_compiled_at = now
    await session.commit()
    await session.refresh(suggestion)
    return suggestion


@router.get("/{wiki_id}", response_model=WikiPageRead)
async def get_wiki_page(
    wiki_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    return wiki


@router.patch("/{wiki_id}", response_model=WikiPageRead)
@router.put("/{wiki_id}", response_model=WikiPageRead)
async def update_wiki_page(
    wiki_id: str,
    body: WikiPageUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")

    data = body.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(wiki, field, value)
    if any(field in data for field in ("title", "summary", "content")):
        await _upsert_wiki_embedding(session, wiki)
    await session.commit()
    await session.refresh(wiki)
    return wiki


@router.delete("/{wiki_id}", status_code=204)
async def delete_wiki_page(
    wiki_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    await session.delete(wiki)
    await session.commit()
    return None


@router.post("/{wiki_id}/sources", response_model=WikiPageSourceRead, status_code=201)
async def upsert_wiki_page_source(
    wiki_id: str,
    body: WikiPageSourceCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    source = await session.get(Source, body.source_id)
    if not source or (source.user_id != user.id and not source.is_shared):
        raise HTTPException(status_code=404, detail="Source not found")

    rows = await session.execute(
        select(WikiPageSource).where(
            WikiPageSource.wiki_id == wiki_id,
            WikiPageSource.source_id == body.source_id,
        )
    )
    evidence = rows.scalar_one_or_none()
    if evidence:
        evidence.relevance_summary = body.relevance_summary
        evidence.key_points = body.key_points
        evidence.supporting_claims = body.supporting_claims
        evidence.cited_chunk_ids = body.cited_chunk_ids
        evidence.confidence_score = body.confidence_score
    else:
        evidence = WikiPageSource(
            wiki_id=wiki_id,
            source_id=body.source_id,
            relevance_summary=body.relevance_summary,
            key_points=body.key_points,
            supporting_claims=body.supporting_claims,
            cited_chunk_ids=body.cited_chunk_ids,
            confidence_score=body.confidence_score,
        )
        session.add(evidence)
    if body.source_id not in wiki.derived_from_sources:
        wiki.derived_from_sources = [*wiki.derived_from_sources, body.source_id]
    await session.commit()
    await session.refresh(evidence)
    return evidence


@router.get("/{wiki_id}/sources", response_model=list[WikiPageSourceRead])
async def list_wiki_page_sources(
    wiki_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    rows = await session.execute(
        select(WikiPageSource).where(WikiPageSource.wiki_id == wiki_id).order_by(WikiPageSource.id)
    )
    return list(rows.scalars())


@router.post("/{wiki_id}/memories", response_model=WikiPageMemoryRead, status_code=201)
async def upsert_wiki_page_memory(
    wiki_id: str,
    body: WikiPageMemoryCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    memory = await session.get(MemoryNode, body.memory_node_id)
    if not memory or memory.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")

    rows = await session.execute(
        select(WikiPageMemory).where(
            WikiPageMemory.wiki_id == wiki_id,
            WikiPageMemory.memory_node_id == body.memory_node_id,
        )
    )
    evidence = rows.scalar_one_or_none()
    if evidence:
        evidence.relevance_summary = body.relevance_summary
        evidence.key_points = body.key_points
        evidence.supporting_claims = body.supporting_claims
        evidence.confidence_score = body.confidence_score
    else:
        evidence = WikiPageMemory(
            wiki_id=wiki_id,
            memory_node_id=body.memory_node_id,
            relevance_summary=body.relevance_summary,
            key_points=body.key_points,
            supporting_claims=body.supporting_claims,
            confidence_score=body.confidence_score,
        )
        session.add(evidence)

    wiki.derived_from_sources = _merge_unique([*(wiki.derived_from_sources or []), *(memory.derived_from_sources or [])])
    wiki.derived_from_notes = _merge_unique([*(wiki.derived_from_notes or []), *(memory.derived_from_notes or [])])
    wiki.needs_recompile = True
    wiki.stale_reason = f"Memory evidence `{memory.title}` was attached or refreshed."
    wiki.stale_triggered_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await session.commit()
    await session.refresh(evidence)
    return evidence


@router.get("/{wiki_id}/memories", response_model=list[WikiPageMemoryRead])
async def list_wiki_page_memories(
    wiki_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    rows = await session.execute(
        select(WikiPageMemory).where(WikiPageMemory.wiki_id == wiki_id).order_by(WikiPageMemory.id)
    )
    return list(rows.scalars())


@router.post("/compile", response_model=WikiPageRead, status_code=201)
async def compile_wiki_page(
    body: WikiCompileRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    notes = []
    sources = []
    if body.note_ids:
        rows = await session.execute(
            select(Note).where(Note.user_id == user.id, Note.id.in_(body.note_ids))
        )
        notes = list(rows.scalars())
        if len(notes) != len(set(body.note_ids)):
            raise HTTPException(status_code=404, detail="One or more notes were not found")
    if body.source_ids:
        rows = await session.execute(
            select(Source).where(
                Source.id.in_(body.source_ids),
                or_(Source.user_id == user.id, Source.is_shared),
            )
        )
        sources = list(rows.scalars())
        if len(sources) != len(set(body.source_ids)):
            raise HTTPException(status_code=404, detail="One or more sources were not found")
    if not notes and not sources:
        raise HTTPException(status_code=422, detail="Choose at least one note or source to compile")

    memory_results = await retrieve_for_wiki(
        session,
        user_id=user.id,
        topic=body.title,
        source_ids=[source.id for source in sources],
        limit=8,
    )
    memory_context = format_memory_context(memory_results, max_chars_per_item=700)

    sections: list[str] = []
    if memory_context:
        sections.append("## Memory Tree Context\n" + memory_context)
    for note in notes:
        sections.append(f"## Note: {note.title}\nID: {note.id}\n\n{note.content or note.abstract or ''}")
    for source in sources:
        content = source.raw_content or ""
        sections.append(f"## Source: {source.title}\nID: {source.id}\n\n{content[:12000]}")

    system_prompt = """你是个人知识图谱的 Wiki Compiler。请把输入的 notes 和 sources 综合成一篇长期维护的中文 Markdown wiki 页面。
要求：
1. 输出包含：当前理解、关键结论、Source Evidence、我的笔记与洞察、开放问题。
2. Source Evidence 中说明每个 source 对当前主题的贡献，不要照搬全文。
3. 保留 note/source id，方便追溯。
4. 不要编造未提供的信息。
5. Memory Tree Context 是系统长期理解，只能作为线索；最终结论仍需尽量落到 notes/sources 证据。
"""
    user_prompt = f"标题：{body.title}\n类型：{body.page_type}\n额外指令：{body.instructions or '无'}\n\n材料：\n" + "\n\n---\n\n".join(sections)

    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        content = response.choices[0].message.content or ""
    except Exception:
        logger.exception("Wiki compilation failed")
        raise HTTPException(status_code=502, detail="Wiki compilation failed") from None

    if not content.strip():
        raise HTTPException(status_code=502, detail="Wiki compiler returned empty content")

    summary = content.splitlines()[0].lstrip("# ").strip() or body.title
    wiki = await persist_wiki_page(
        session=session,
        body=WikiPageCreate(
            title=body.title,
            page_type=body.page_type,
            summary=summary[:500],
            content=content,
            derived_from_notes=[note.id for note in notes],
            derived_from_sources=[source.id for source in sources],
            tags=["compiled"],
            open_questions=[f"Memory context used: {result.node.id}" for result in memory_results[:5]],
        ),
        user_id=user.id,
    )
    return wiki


@router.post("/from-memory", response_model=WikiPageRead, status_code=201)
async def create_wiki_draft_from_memory(
    body: WikiFromMemoryRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    memory = await session.get(MemoryNode, body.memory_node_id)
    if not memory or memory.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")
    if memory.node_type != "topic":
        raise HTTPException(status_code=422, detail="Only topic memory can be converted into a wiki draft")

    title = body.title or _wiki_title_from_memory(memory)
    tags = _merge_unique([*body.tags, "draft", "from-memory", "topic-memory"])
    content = _wiki_draft_content_from_memory(memory)
    wiki = await persist_wiki_page(
        session=session,
        body=WikiPageCreate(
            title=title,
            page_type=body.page_type,
            summary=memory.summary,
            content=content,
            derived_from_notes=memory.derived_from_notes,
            derived_from_sources=memory.derived_from_sources,
            tags=tags,
            confidence_score=memory.confidence_score,
        ),
        user_id=user.id,
    )
    return wiki


def _wiki_title_from_memory(memory: MemoryNode) -> str:
    title = memory.title.removeprefix("Topic Memory - ").strip()
    return title or memory.title


def _wiki_draft_content_from_memory(memory: MemoryNode) -> str:
    return (
        f"# {_wiki_title_from_memory(memory)}\n\n"
        "<!-- Draft generated from Topic Memory. Review before promoting to stable wiki. -->\n\n"
        "## Current Understanding\n\n"
        f"{memory.content}\n\n"
        "## Source Evidence\n\n"
        + "\n".join(f"- `{source_id}`" for source_id in memory.derived_from_sources)
        + "\n\n## Review Checklist\n\n"
        "- [ ] Verify claims against source evidence.\n"
        "- [ ] Merge duplicate or weak points.\n"
        "- [ ] Promote from draft when stable.\n"
    )


def _merge_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged
