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
from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.source import Source
from pkg.models.user import User
from pkg.models.foundation.wiki import (
    WikiArticleDraft,
    WikiEmbedding,
    WikiInsightCandidate,
    WikiPage,
    WikiPageMemory,
    WikiPageSource,
    WikiRecompileSuggestion,
)
from pkg.schemas.wiki import (
    WikiArticleDraftStatusUpdate,
    WikiCandidateMergeAction,
    WikiCandidateNoteConversionRead,
    WikiCloneDraftRequest,
    WikiCompileRequest,
    WikiFromMemoryRequest,
    WikiInsightCandidateRead,
    WikiInsightCandidateStatusUpdate,
    WikiMiningRunCreate,
    WikiMiningRunDetail,
    WikiMiningRunList,
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
    WikiArticleDraftRead,
)
from pkg.schemas.reference import ReferenceRead, ReferenceResolveRequest, ReferenceResolveResponse
from pkg.services.cross_cutting.embedding import get_embedding_service
from pkg.services.cross_cutting.llm import create_async_client
from pkg.services.foundation.memory_retriever import format_memory_context, retrieve_for_wiki
from pkg.services.foundation.wiki_lifecycle import get_wiki_role
from pkg.services.foundation.wiki_mining import get_wiki_mining_run_detail, list_wiki_mining_runs, run_wiki_mining
from pkg.services.foundation.wiki_recompile import suggest_wiki_recompile_for_trigger
from pkg.services.foundation.wiki_templates import build_wiki_template

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/mining/runs", response_model=WikiMiningRunDetail, status_code=201)
async def create_wiki_mining_run(
    body: WikiMiningRunCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await run_wiki_mining(
        session,
        user_id=user.id,
        window_days=body.window_days,
        max_new_items=body.max_new_items,
        max_related_items=body.max_related_items,
    )
    return WikiMiningRunDetail(run=result.run, insights=result.insights, articles=result.articles)


@router.get("/mining/runs", response_model=WikiMiningRunList)
async def get_wiki_mining_runs(
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    items, total = await list_wiki_mining_runs(session, user_id=user.id, limit=limit, offset=offset)
    return WikiMiningRunList(items=items, total=total)


@router.get("/mining/runs/{run_id}", response_model=WikiMiningRunDetail)
async def get_wiki_mining_run(
    run_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    run, insights, articles = await get_wiki_mining_run_detail(session, user_id=user.id, run_id=run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Wiki mining run not found")
    return WikiMiningRunDetail(run=run, insights=insights, articles=articles)


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


@router.patch("/mining/insights/{insight_id}", response_model=WikiInsightCandidateRead)
async def update_wiki_insight_candidate_status(
    insight_id: int,
    body: WikiInsightCandidateStatusUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    insight = await session.get(WikiInsightCandidate, insight_id)
    if not insight or insight.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki insight candidate not found")
    insight.status = body.status
    insight.reviewer_note = body.reviewer_note
    await session.commit()
    await session.refresh(insight)
    return insight


@router.patch("/mining/articles/{article_id}", response_model=WikiArticleDraftRead)
async def update_wiki_article_draft_status(
    article_id: int,
    body: WikiArticleDraftStatusUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    article = await session.get(WikiArticleDraft, article_id)
    if not article or article.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki article draft not found")

    article.status = body.status
    article.reviewer_note = body.reviewer_note

    if body.status == "accepted":
        tags = ["wiki-draft", "from-mining-candidate"]
        evidence_refs = article.evidence_refs or []
        source_ids = [ref.get("ref_id") for ref in evidence_refs if ref.get("ref_type") == "source" and ref.get("ref_id")]
        note_ids = [ref.get("ref_id") for ref in evidence_refs if ref.get("ref_type") == "note" and ref.get("ref_id")]
        wiki = await persist_wiki_page(
            session=session,
            body=WikiPageCreate(
                title=body.wiki_title or article.title,
                page_type=body.page_type or article.page_type,
                summary=article.summary,
                content=article.content,
                derived_from_sources=_merge_unique(source_ids),
                derived_from_notes=_merge_unique(note_ids),
                tags=tags,
                open_questions=["Review generated from wiki mining candidate article before stabilizing."],
            ),
            user_id=user.id,
        )
        article.status = "accepted"
        metadata = dict(article.metadata_ or {})
        metadata["accepted_wiki_id"] = wiki.id
        article.metadata_ = metadata
    else:
        await session.commit()

    await session.refresh(article)
    return article


@router.post("/mining/articles/{article_id}/merge", response_model=WikiArticleDraftRead)
async def merge_wiki_article_candidate(
    article_id: int,
    body: WikiCandidateMergeAction,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    article = await session.get(WikiArticleDraft, article_id)
    if not article or article.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki article draft not found")

    metadata = dict(article.metadata_ or {})
    metadata["merge_target_wiki_id"] = body.target_wiki_id
    metadata["merge_placeholder"] = True
    article.metadata_ = metadata
    article.status = "merged"
    article.reviewer_note = body.reviewer_note
    await session.commit()
    await session.refresh(article)
    return article


@router.post("/mining/articles/{article_id}/convert-to-note", response_model=WikiCandidateNoteConversionRead)
async def convert_wiki_article_candidate_to_note(
    article_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    article = await session.get(WikiArticleDraft, article_id)
    if not article or article.user_id != user.id:
        raise HTTPException(status_code=404, detail="Wiki article draft not found")

    metadata = dict(article.metadata_ or {})
    metadata["converted_to_note_placeholder"] = True
    article.metadata_ = metadata
    article.reviewer_note = (article.reviewer_note or "").strip() or "Converted to note placeholder"
    await session.commit()
    await session.refresh(article)
    return WikiCandidateNoteConversionRead(
        article_id=article.id,
        status="placeholder",
        note_title=article.title,
        note_content=article.content,
        metadata_=article.metadata_,
    )


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

    system_prompt = """你是个人知识图谱的 Wiki Compiler。请把输入的 notes 和 sources 综合成一篇长期维护、适合阅读的中文 Markdown wiki 页面。
要求：
1. 输出更像百科条目，而不是内部提纲或工作底稿。
2. 优先写成可连续阅读的自然段，而不是堆很多碎 bullet。
3. 结构应优先包含：概述 / 背景 / 核心内容 / 影响或适用范围 / 开放问题。
4. 可以在正文中自然引用 notes/sources，但不要把正文写成“Source Evidence”清单。
5. 保留 note/source id，方便追溯，但把引用写得尽量不打断阅读。
6. 不要编造未提供的信息。
7. Memory Tree Context 是系统长期理解，只能作为线索；最终结论仍需尽量落到 notes/sources 证据。
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
    """Create a wiki draft from topic memory.

    This is a draft/stable-knowledge handoff from compiled memory, not a raw
    summary step and not an automatic overwrite of an existing stable wiki.
    """

    memory = await session.get(MemoryNode, body.memory_node_id)
    if not memory or memory.user_id != user.id:
        raise HTTPException(status_code=404, detail="Memory node not found")
    if memory.node_type != "topic":
        raise HTTPException(status_code=422, detail="Only topic memory can be converted into a wiki draft")

    title = body.title or _wiki_title_from_memory(memory)
    tags = _merge_unique([*body.tags, "wiki-draft", "from-memory", "topic-memory"])
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
        "## Overview\n\n"
        f"{memory.content}\n\n"
        "## Background and Context\n\n"
        "Expand this draft into a readable wiki article. Explain the topic in prose, clarify key ideas, and keep factual claims grounded in supporting evidence.\n\n"
        "## References To Review\n\n"
        + "\n".join(f"- `{source_id}`" for source_id in memory.derived_from_sources)
        + "\n\n## Open Questions\n\n"
        "- Which claims still need stronger evidence?\n"
        "- Which paragraphs should be rewritten for clarity or neutrality?\n"
        "- What should be added before promoting this draft to stable?\n"
    )


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
    if ref_type == "memory":
        memory = await session.get(MemoryNode, ref_id)
        if not memory or memory.user_id != user_id:
            return None
        return ReferenceRead(
            ref_type="memory",
            ref_id=memory.id,
            title=memory.title,
            subtitle=memory.level,
            href=f"/memory?node={memory.id}",
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
