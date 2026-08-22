import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.user import User
from pkg.models.foundation.wiki import (
    WikiEmbedding,
    WikiPage,
    WikiRecompileSuggestion,
)
from pkg.schemas.wiki import (
    WikiCloneDraftRequest,
    WikiCompileRequest,
    WikiPageCreate,
    WikiPageList,
    WikiPageRead,
    WikiPageUpdate,
    WikiRecompileSuggestionList,
    WikiRecompileSuggestionRead,
    WikiSuggestionStatusUpdate,
    WikiSuggestRequest,
)
from pkg.schemas.reference import ReferenceRead, ReferenceResolveRequest, ReferenceResolveResponse
from pkg.services.cross_cutting.embedding import get_embedding_service
from pkg.services.cross_cutting.llm import create_async_client
from pkg.services.foundation.wiki_lifecycle import get_wiki_role
from pkg.services.foundation.wiki_recompile import suggest_wiki_recompile_for_trigger
from pkg.services.foundation.wiki_templates import build_wiki_template

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/references/resolve", response_model=ReferenceResolveResponse)
async def resolve_wiki_references(
    body: ReferenceResolveRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    items: list[ReferenceRead] = []
    for ref in body.refs:
        ref_type = str(ref.get("ref_type") or ref.get("type") or "").strip().lower()
        ref_id = str(ref.get("ref_id") or ref.get("id") or "").strip()
        excerpt = ref.get("excerpt") if isinstance(ref.get("excerpt"), str) else None
        if not ref_type or not ref_id:
            continue

        resolved = await _resolve_reference(session=session, user_id=user.id, ref_type=ref_type, ref_id=ref_id, excerpt=excerpt)
        if resolved:
            items.append(resolved)
    return ReferenceResolveResponse(items=items)


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
    content = body.content or build_wiki_template(body.title, body.page_type)
    wiki = WikiPage(
        id=wiki_id,
        user_id=user_id,
        title=body.title,
        page_type=body.page_type,
        summary=body.summary,
        content=content,
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
    target_status = body.status
    if target_status != suggestion.status:
        duplicate_stmt = select(WikiRecompileSuggestion.id).where(
            WikiRecompileSuggestion.user_id == user.id,
            WikiRecompileSuggestion.wiki_id == suggestion.wiki_id,
            WikiRecompileSuggestion.trigger_type == suggestion.trigger_type,
            WikiRecompileSuggestion.trigger_id == suggestion.trigger_id,
            WikiRecompileSuggestion.status == target_status,
            WikiRecompileSuggestion.id != suggestion.id,
        )
        duplicate_id = (await session.execute(duplicate_stmt)).scalar_one_or_none()
        if duplicate_id is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Another wiki review item already has status '{target_status}' for the same trigger. Refresh the queue and use the existing item instead.",
            )

    suggestion.status = target_status
    suggestion.reviewer_note = body.reviewer_note
    if suggestion.status in {"accepted", "rejected", "dismissed", "applied"}:
        suggestion.reviewed_at = now
    if suggestion.status == "applied":
        suggestion.applied_at = now

    with session.no_autoflush:
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
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="This wiki review item conflicted with another item for the same trigger and status. Refresh the queue and try again.",
        ) from exc
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
    if get_wiki_role(wiki) == "stable":
        tags = list(wiki.tags or [])
        if "edited-stable" not in tags:
            wiki.tags = [*tags, "edited-stable"]
    for field, value in data.items():
        setattr(wiki, field, value)
    if any(field in data for field in ("title", "summary", "content")):
        await _upsert_wiki_embedding(session, wiki)
    await session.commit()
    await session.refresh(wiki)
    return wiki


@router.post("/{wiki_id}/clone-draft", response_model=WikiPageRead, status_code=201)
async def clone_wiki_page_as_draft(
    wiki_id: str,
    body: WikiCloneDraftRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    wiki = await session.get(WikiPage, wiki_id)
    if not wiki or wiki.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki page not found")

    title = body.title or f"{wiki.title} Draft"
    tags = _merge_unique([*(wiki.tags or []), "wiki-draft", "from-stable-wiki"])
    if "wiki-stable" in tags:
        tags.remove("wiki-stable")

    draft = await persist_wiki_page(
        session=session,
        body=WikiPageCreate(
            title=title,
            page_type=wiki.page_type,
            summary=wiki.summary,
            content=wiki.content,
            domains=wiki.domains,
            tags=tags,
            derived_from_notes=wiki.derived_from_notes,
            derived_from_sources=wiki.derived_from_sources,
            open_questions=wiki.open_questions,
            confidence_score=wiki.confidence_score,
        ),
        user_id=user.id,
    )
    return draft


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

    sections: list[str] = []
    for note in notes:
        sections.append(f"## Note: {note.title}\nID: {note.id}\n\n{note.content or note.abstract or ''}")
    for source in sources:
        content = source.raw_content or ""
        sections.append(f"## Source: {source.title}\nID: {source.id}\n\n{content[:12000]}")

    system_prompt = """你是个人知识图谱的 Wiki Compiler。请把输入的 notes 和 sources 综合成一篇长期维护、适合阅读的中文 Markdown wiki 页面。
要求：
1. 输出更像百科条目，而不是内部提纲或工作底稿。
2. 优先写成可连续阅读的自然段，而不是堆很多碎 bullet。
3. 结构应优先包含：概述 / 背景 / 核心内容 / 影响或适用范围 / 开放问题。
4. 可以在正文中自然引用 notes/sources，但不要把正文写成“Source Evidence”清单。
5. 保留 note/source id，方便追溯，但把引用写得尽量不打断阅读。
6. 不要编造未提供的信息。
7. 所有结论都必须来自本次显式提供的 notes/sources，不得依赖未列出的系统记忆或隐式上下文。
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
            tags=["wiki-compiled"],
            open_questions=[],
        ),
        user_id=user.id,
    )
    return wiki


def _trim_text(value: str | None, limit: int = 1200) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n\n...[truncated]"


def _extract_section_excerpt(content: str | None, section: str, limit: int = 1200) -> str:
    text = (content or "").strip()
    if not text:
        return ""
    section_name = section.strip().lower()
    if not section_name:
        return _trim_text(text, limit=limit)

    lines = text.splitlines()
    capture = False
    collected: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## "):
            heading = stripped.removeprefix("## ").strip().lower()
            if capture:
                break
            capture = heading == section_name
            if capture:
                collected.append(line)
            continue
        if capture:
            collected.append(line)

    excerpt = "\n".join(collected).strip()
    return _trim_text(excerpt or text, limit=limit)


def _merge_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged


async def _resolve_reference(
    *,
    session: AsyncSession,
    user_id: str,
    ref_type: str,
    ref_id: str,
    excerpt: str | None = None,
) -> ReferenceRead | None:
    if ref_type == "source":
        source = await session.get(Source, ref_id)
        if not source or (source.user_id != user_id and not source.is_shared):
            return None
        return ReferenceRead(
            ref_type="source",
            ref_id=source.id,
            title=source.title,
            subtitle=source.source_type,
            href=f"/sources/{source.id}",
            excerpt=excerpt,
            metadata_={"url": source.url},
        )
    if ref_type == "note":
        note = await session.get(Note, ref_id)
        if not note or note.user_id != user_id:
            return None
        return ReferenceRead(
            ref_type="note",
            ref_id=note.id,
            title=note.title,
            subtitle=note.note_type,
            href=f"/notes/{note.id}",
            excerpt=excerpt,
        )
    if ref_type == "wiki":
        wiki = await session.get(WikiPage, ref_id)
        if not wiki or wiki.user_id != user_id:
            return None
        return ReferenceRead(
            ref_type="wiki",
            ref_id=wiki.id,
            title=wiki.title,
            subtitle=wiki.page_type,
            href=f"/wiki/{wiki.id}",
            excerpt=excerpt,
            status=get_wiki_role(wiki),
        )
    return ReferenceRead(
        ref_type=ref_type,
        ref_id=ref_id,
        title=ref_id,
        href=None,
        excerpt=excerpt,
    )
