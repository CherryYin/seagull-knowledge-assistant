import asyncio
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import get_session
from pkg.models.category import Category
from pkg.models.source import Source, SourceChunk, SourceEmbedding
from pkg.models.user import User
from pkg.schemas.source import ChunkRead, SourceCreate, SourceList, SourceRead, SourceUpdate
from pkg.services.chunking import chunk_text
from pkg.services.embedding import get_embedding_service
from pkg.services.storage import get_storage_service

router = APIRouter()
logger = logging.getLogger(__name__)

TEXT_FILE_SUFFIXES = {
    ".md",
    ".txt",
    ".json",
    ".csv",
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".html",
    ".css",
    ".yml",
    ".yaml",
}


def make_source_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    suffix = uuid.uuid4().hex[:8]
    return f"src-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}-{suffix}"


async def extract_text_content(
    filename: str | None,
    content_type: str | None,
    payload: bytes,
    pdf_type: str | None = None,
) -> str | None:
    """Extract text from uploaded files.

    For plain text files, decodes UTF-8 directly.
    For binary documents (PDF, DOCX, PPTX, XLSX, images), uses Docling with OCR.
    For text-based PDFs (pdf_type="text"), uses PyMuPDF for fast extraction.
    For scanned/image PDFs, forces full-page OCR to bypass broken text layers.
    For unclear PDFs (pdf_type="vlm"), uses vision LLM page-by-page.
    """
    fname = filename or ""
    suffix = Path(fname).suffix.lower()

    # Plain text files — direct decode
    if (content_type or "").startswith("text/") or suffix in TEXT_FILE_SUFFIXES:
        return payload.decode("utf-8", errors="replace")

    # Text-based PDF — fast path via PyMuPDF (no OCR)
    if pdf_type == "text" and suffix == ".pdf":
        from pkg.services.document_extractor import extract_content_pymupdf

        return await asyncio.to_thread(extract_content_pymupdf, payload, fname)

    # Unclear/low-quality PDF — vision LLM page-by-page
    if pdf_type == "vlm" and suffix == ".pdf":
        from pkg.services.document_extractor import extract_content_vlm_from_bytes

        return await extract_content_vlm_from_bytes(payload, fname)

    # Binary documents — use Docling
    # For scanned/image PDFs, force full-page OCR to bypass broken text layers
    from pkg.services.document_extractor import extract_content

    force_ocr = pdf_type == "ocr" and suffix == ".pdf"
    return await asyncio.to_thread(extract_content, payload, fname, force_full_page_ocr=force_ocr)


async def persist_source(
    *,
    session: AsyncSession,
    body: SourceCreate,
    user_id: str,
    file_path: str | None = None,
    raw_content_override: str | None = None,
    content_hash_override: str | None = None,
) -> Source:
    source_id = make_source_id(body.title, body.id)
    raw_content = raw_content_override if raw_content_override is not None else body.raw_content
    if raw_content:
        raw_content = raw_content.replace("\x00", "")
    content_hash = content_hash_override or hashlib.sha256((raw_content or "").encode()).hexdigest()

    source = Source(
        id=source_id,
        user_id=user_id,
        category_id=body.category_id,
        title=body.title,
        source_type=body.source_type,
        url=body.url,
        raw_content=raw_content,
        file_path=file_path or body.file_path,
        content_hash=content_hash,
        metadata_=body.metadata,
    )
    session.add(source)

    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(source.title)
        summary_vec = await emb_svc.embed_text(raw_content if raw_content else source.title)
        session.add(SourceEmbedding(source_id=source_id, title_vec=title_vec, summary_vec=summary_vec))

        if raw_content:
            chunks = chunk_text(raw_content)
            if chunks:
                vectors = await emb_svc.embed_batch(chunks)
                for idx, (chunk_content, vec) in enumerate(zip(chunks, vectors)):
                    session.add(SourceChunk(
                        source_id=source_id,
                        chunk_index=idx,
                        content=chunk_content,
                        embedding=vec,
                    ))
    except Exception:
        logger.error("Embedding generation failed for source %s — saving without embeddings", source_id, exc_info=True)

    await session.commit()
    await session.refresh(source)
    return source


@router.post("", response_model=SourceRead, status_code=201)
async def create_source(
    body: SourceCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await persist_source(session=session, body=body, user_id=user.id)


@router.post("/upload", response_model=SourceRead, status_code=201)
async def upload_source(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    source_type: str = Form("article"),
    category_id: int = Form(1),
    url: str | None = Form(None),
    pdf_type: str | None = Form(None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded source file is empty")

    inferred_title = title or Path(file.filename or "source").stem
    body = SourceCreate(
        title=inferred_title,
        source_type=source_type,
        category_id=category_id,
        url=url,
        raw_content=await extract_text_content(file.filename, file.content_type, payload, pdf_type=pdf_type),
    )

    source_id = make_source_id(body.title, body.id)
    category = await session.get(Category, category_id)
    category_name = category.name if category else None
    storage = get_storage_service()
    object_key = storage.build_object_key("sources", source_id, file.filename, category_name=category_name)
    storage_uri = await storage.upload_bytes(
        object_key=object_key,
        data=payload,
        content_type=file.content_type,
    )

    return await persist_source(
        session=session,
        body=body.model_copy(update={"id": source_id, "file_path": storage_uri}),
        user_id=user.id,
        file_path=storage_uri,
        raw_content_override=body.raw_content,
        content_hash_override=hashlib.sha256(payload).hexdigest(),
    )


@router.get("", response_model=SourceList)
async def list_sources(
    source_type: str | None = None,
    category_id: int | None = None,
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    ownership = or_(Source.user_id == user.id, Source.is_shared == True)
    stmt = select(Source).where(ownership)
    count_stmt = select(func.count()).select_from(Source).where(ownership)

    if category_id is not None:
        stmt = stmt.where(Source.category_id == category_id)
        count_stmt = count_stmt.where(Source.category_id == category_id)
    if source_type:
        stmt = stmt.where(Source.source_type == source_type)
        count_stmt = count_stmt.where(Source.source_type == source_type)

    stmt = stmt.order_by(Source.ingested_at.desc()).offset(offset).limit(limit)

    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    items = list(rows.scalars())

    # Populate category_name
    cat_ids = {s.category_id for s in items}
    cat_map: dict[int, str] = {}
    if cat_ids:
        cat_rows = await session.execute(select(Category).where(Category.id.in_(cat_ids)))
        cat_map = {c.id: c.name for c in cat_rows.scalars()}

    result_items = []
    for s in items:
        read = SourceRead.model_validate(s)
        read.category_name = cat_map.get(s.category_id)
        result_items.append(read)

    return SourceList(items=result_items, total=total)


@router.get("/{source_id}", response_model=SourceRead)
async def get_source(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or (source.user_id != user.id and not source.is_shared):
        raise HTTPException(status_code=404, detail="Source not found")
    category = await session.get(Category, source.category_id)
    result = SourceRead.model_validate(source)
    result.category_name = category.name if category else None
    return result


@router.patch("/{source_id}", response_model=SourceRead)
@router.put("/{source_id}", response_model=SourceRead)
async def update_source(
    source_id: str,
    body: SourceUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    patch = body.model_dump(exclude_unset=True)
    if not patch:
        category = await session.get(Category, source.category_id)
        result = SourceRead.model_validate(source)
        result.category_name = category.name if category else None
        return result

    for key, value in patch.items():
        setattr(source, key, value)

    # Re-embed if title changed
    if "title" in patch:
        emb_svc = get_embedding_service()
        emb_row = await session.get(SourceEmbedding, source_id)
        title_vec = await emb_svc.embed_text(source.title)
        if emb_row:
            emb_row.title_vec = title_vec
        else:
            summary_vec = await emb_svc.embed_text(source.title)
            session.add(SourceEmbedding(source_id=source_id, title_vec=title_vec, summary_vec=summary_vec))

    await session.commit()
    await session.refresh(source)

    category = await session.get(Category, source.category_id)
    result = SourceRead.model_validate(source)
    result.category_name = category.name if category else None
    return result


@router.get("/{source_id}/chunks", response_model=list[ChunkRead])
async def get_source_chunks(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or (source.user_id != user.id and not source.is_shared):
        raise HTTPException(status_code=404, detail="Source not found")
    rows = await session.execute(
        select(SourceChunk)
        .where(SourceChunk.source_id == source_id)
        .order_by(SourceChunk.chunk_index)
    )
    return list(rows.scalars())


@router.delete("/{source_id}", status_code=204)
async def delete_source(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    # Delete stored file from MinIO
    if source.file_path and source.file_path.startswith("minio://"):
        try:
            await get_storage_service().delete_object(source.file_path)
        except Exception:
            logger.warning("Failed to delete MinIO object for source %s: %s", source_id, source.file_path, exc_info=True)

    # Delete related embedding
    emb = await session.get(SourceEmbedding, source_id)
    if emb:
        await session.delete(emb)

    # Delete related chunks
    chunks = await session.execute(
        select(SourceChunk).where(SourceChunk.source_id == source_id)
    )
    for chunk in chunks.scalars():
        await session.delete(chunk)

    await session.delete(source)
    await session.commit()


@router.get("/{source_id}/file")
async def get_source_file(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or (source.user_id != user.id and not source.is_shared) or not source.file_path:
        raise HTTPException(status_code=404, detail="Source file not found")

    if source.file_path.startswith("minio://"):
        url = await get_storage_service().generate_download_url(source.file_path)
        return RedirectResponse(url=url)

    local_path = Path(source.file_path).resolve()
    allowed_root = Path(settings.DATA_DIR).resolve()
    if not local_path.is_relative_to(allowed_root):
        raise HTTPException(status_code=403, detail="Access denied")
    if not local_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
    return FileResponse(local_path)


# --- RSS Feed Endpoints ---


@router.post("/{source_id}/rss/enable", response_model=SourceRead)
async def enable_rss(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Enable RSS fetching for a web source. Validates the feed URL first."""
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")
    if source.source_type != "web":
        raise HTTPException(status_code=422, detail="RSS can only be enabled on web sources")
    if not source.url:
        raise HTTPException(status_code=422, detail="Source must have a URL to enable RSS")

    import feedparser
    import httpx

    _headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    url = source.url.rstrip("/")
    # Build candidate URLs: original, .rss suffix, /feed
    candidates = [url]
    if not url.endswith((".rss", ".xml", ".atom", "/feed")):
        candidates.append(url + ".rss")
        candidates.append(url + "/feed")

    feed = None
    feed_url = url
    last_error = None
    async with httpx.AsyncClient(timeout=settings.RSS_FETCH_TIMEOUT, headers=_headers) as client:
        for candidate in candidates:
            try:
                resp = await client.get(candidate, follow_redirects=True)
                resp.raise_for_status()
                parsed = feedparser.parse(resp.content)
                if parsed.entries:
                    feed = parsed
                    feed_url = candidate
                    break
            except httpx.HTTPError as exc:
                last_error = exc

    if not feed or not feed.entries:
        detail = f"Cannot find a valid RSS feed for this URL"
        if last_error:
            detail += f": {last_error}"
        raise HTTPException(status_code=422, detail=detail)

    meta = dict(source.metadata_ or {})
    meta["rss_enabled"] = "true"
    meta["feed_title"] = feed.feed.get("title", "")
    meta["feed_url"] = feed_url
    meta["entries_available"] = len(feed.entries)
    if feed_url != source.url:
        source.url = feed_url
    source.metadata_ = meta
    await session.commit()
    await session.refresh(source)
    return source


@router.post("/{source_id}/rss/disable", response_model=SourceRead)
async def disable_rss(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Disable RSS fetching for a web source."""
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    meta = dict(source.metadata_ or {})
    meta.pop("rss_enabled", None)
    source.metadata_ = meta
    await session.commit()
    await session.refresh(source)
    return source


@router.post("/{source_id}/rss/fetch")
async def fetch_rss_now(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Manually trigger an immediate RSS fetch for this source."""
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    meta = source.metadata_ or {}
    if meta.get("rss_enabled") != "true":
        raise HTTPException(status_code=422, detail="RSS is not enabled for this source")

    from pkg.services.rss_fetcher import fetch_single_feed

    new_count = await fetch_single_feed(source, session)
    return {"new_articles": new_count}


@router.get("/{source_id}/articles", response_model=SourceList)
async def list_feed_articles(
    source_id: str,
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """List articles fetched from this RSS feed."""
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    from sqlalchemy import text as sql_text

    base_filter = sql_text("metadata->>'feed_source_id' = :feed_id")

    count_stmt = (
        select(func.count())
        .select_from(Source)
        .where(base_filter.bindparams(feed_id=source_id))
    )
    total = (await session.execute(count_stmt)).scalar() or 0

    stmt = (
        select(Source)
        .where(base_filter.bindparams(feed_id=source_id))
        .order_by(Source.ingested_at.desc())
        .offset(offset)
        .limit(limit)
    )
    rows = await session.execute(stmt)
    items = list(rows.scalars())

    return SourceList(items=items, total=total)


@router.post("/rss/summarize")
async def trigger_rss_summary(user: User = Depends(get_current_user)):
    """Manually trigger RSS topic summarization."""
    from pkg.services.rss_summarizer import summarize_rss_by_topic

    note_ids = await summarize_rss_by_topic()
    return {"note_ids": note_ids, "count": len(note_ids)}
