import asyncio
import hashlib
import logging
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import get_session
from pkg.models.category import Category
from pkg.models.foundation.source import Source, SourceChunk, SourceEmbedding
from pkg.models.user import User
from pkg.schemas.source import ChunkRead, SourceCreate, SourceList, SourceRead, SourceUpdate, SourceUploadResult
from pkg.services.cross_cutting.embedding import get_embedding_service
from pkg.services.cross_cutting.storage import get_storage_service
from pkg.services.foundation.chunking import chunk_text
from pkg.services.foundation.discovery_review import sync_discovery_review_for_source
from pkg.services.foundation.source_retention import apply_source_retention
from pkg.services.foundation.web_extractor import WebPageFetchError, fetch_web_page

router = APIRouter()
logger = logging.getLogger(__name__)

SOURCE_LIKE_TAGS_DISALLOWED = {"from-agent", "agent-output"}

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

RSS_CANDIDATE_SUFFIXES = (".rss", ".xml", ".atom", "/feed")
RSS_DISCOVERY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _pdf_filename_from_url(url: str, fallback: str) -> str:
    name = Path(urlparse(url).path).name
    if name.lower().endswith(".pdf"):
        return name
    safe = re.sub(r"[^a-z0-9]+", "-", fallback.lower()).strip("-") or "source"
    return f"{safe[:60]}.pdf"


def make_source_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    suffix = uuid.uuid4().hex[:8]
    slug = re.sub(r"[^a-z0-9]+", "-", title[:80].lower()).strip("-") or "source"
    return f"src-{now.strftime('%Y%m%d')}-{slug[:40]}-{suffix}"


def _is_placeholder_or_url_title(title: str) -> bool:
    normalized = title.strip().lower()
    return normalized in {"untitled", "new source", "web"} or normalized.startswith(("http://", "https://"))


def _looks_like_user_authored_note(body: SourceCreate) -> bool:
    metadata = body.metadata or {}
    tags = metadata.get("tags") if isinstance(metadata.get("tags"), list) else []
    markers = {str(item).strip().lower() for item in tags if item}
    title = (body.title or "").strip().lower()
    raw_content = (body.raw_content or "").strip().lower()
    if markers & SOURCE_LIKE_TAGS_DISALLOWED:
        return True
    if title in {"agent output", "assistant output", "chat output"}:
        return True
    return body.source_type == "conversation" and not body.url and raw_content.startswith(("# ", "## ", "总结", "summary"))


def _rss_candidate_urls(url: str) -> list[str]:
    base = url.rstrip("/")
    candidates = [base]
    if not base.endswith(RSS_CANDIDATE_SUFFIXES):
        candidates.extend([base + ".rss", base + "/feed", base + ".xml", base + ".atom"])
    return list(dict.fromkeys(candidates))


async def discover_rss_feed(url: str) -> dict[str, Any] | None:
    """Best-effort RSS discovery for a web URL."""
    import feedparser
    import httpx

    async with httpx.AsyncClient(timeout=settings.RSS_FETCH_TIMEOUT, headers=RSS_DISCOVERY_HEADERS) as client:
        for candidate in _rss_candidate_urls(url):
            try:
                resp = await client.get(candidate, follow_redirects=True)
                resp.raise_for_status()
            except httpx.HTTPError:
                continue
            parsed = feedparser.parse(resp.content)
            if parsed.entries:
                return {
                    "feed": parsed,
                    "feed_url": str(resp.url),
                    "entries_available": len(parsed.entries),
                    "feed_title": parsed.feed.get("title", ""),
                }
    return None


def is_url_backed_source(source: Source) -> bool:
    return source.source_type in {"web", "article"} and bool(source.url)


async def maybe_enable_rss_for_source(source: Source, *, auto_fetch: bool, session: AsyncSession) -> bool:
    if not is_url_backed_source(source):
        return False
    meta = dict(source.metadata_ or {})
    if meta.get("rss_enabled") == "true" or meta.get("feed_source_id"):
        return False

    discovered = await discover_rss_feed(source.url)
    if not discovered:
        meta["rss_auto_discovery"] = "not_found"
        source.metadata_ = meta
        return False

    meta["rss_enabled"] = "true"
    meta["feed_title"] = discovered["feed_title"]
    meta["feed_url"] = discovered["feed_url"]
    meta["entries_available"] = discovered["entries_available"]
    meta["feed_auto_detected"] = True
    meta["rss_auto_discovery"] = "found"
    source.url = discovered["feed_url"]
    source.metadata_ = meta

    if auto_fetch:
        from pkg.services.foundation.rss_fetcher import fetch_single_feed

        await fetch_single_feed(source, session)
    return True


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
        from pkg.services.foundation.document_extractor import extract_content_pymupdf

        return await asyncio.to_thread(extract_content_pymupdf, payload, fname)

    # Unclear/low-quality PDF — vision LLM page-by-page
    if pdf_type == "vlm" and suffix == ".pdf":
        from pkg.services.foundation.document_extractor import extract_content_vlm_from_bytes

        return await extract_content_vlm_from_bytes(payload, fname)

    # Binary documents — use Docling
    # For scanned/image PDFs, force full-page OCR to bypass broken text layers
    from pkg.services.foundation.document_extractor import extract_content

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
        metadata_=apply_source_retention(body.source_type, body.metadata),
    )
    session.add(source)

    index_succeeded = await upsert_source_embeddings(session, source)
    metadata = dict(source.metadata_ or {})
    metadata["index_status"] = "completed" if index_succeeded else "failed"
    metadata["indexed_at"] = datetime.now(timezone.utc).isoformat()
    source.metadata_ = metadata

    try:
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    await session.refresh(source)
    return source


async def find_owned_uploaded_source_by_hash(
    session: AsyncSession,
    *,
    user_id: str,
    content_hash: str,
) -> Source | None:
    result = await session.execute(
        select(Source).where(
            Source.user_id == user_id,
            Source.content_hash == content_hash,
            Source.file_path.is_not(None),
        ).order_by(Source.ingested_at.asc()).limit(1)
    )
    return result.scalars().first()


def source_embedding_text(source: Source) -> str:
    metadata = source.metadata_ or {}
    embedding_text = metadata.get("embedding_text")
    if isinstance(embedding_text, str) and embedding_text.strip():
        return embedding_text.strip()
    return (source.raw_content or source.title or "").strip()


async def upsert_source_embeddings(session: AsyncSession, source: Source) -> bool:
    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(source.title)
        text_for_embedding = source_embedding_text(source)
        summary_vec = await emb_svc.embed_text(text_for_embedding or source.title)
        existing = await session.get(SourceEmbedding, source.id)
        if existing:
            existing.title_vec = title_vec
            existing.summary_vec = summary_vec
        else:
            session.add(SourceEmbedding(source_id=source.id, title_vec=title_vec, summary_vec=summary_vec))

        if text_for_embedding:
            await session.execute(delete(SourceChunk).where(SourceChunk.source_id == source.id))
            chunks = chunk_text(text_for_embedding)
            if chunks:
                vectors = await emb_svc.embed_batch(chunks)
                for idx, (chunk_content, vec) in enumerate(zip(chunks, vectors)):
                    session.add(SourceChunk(
                        source_id=source.id,
                        chunk_index=idx,
                        content=chunk_content,
                        embedding=vec,
                    ))
        return True
    except Exception:
        logger.error("Embedding generation failed for source %s — saving without embeddings", source.id, exc_info=True)
        return False


@router.post("", response_model=SourceRead, status_code=201)
async def create_source(
    body: SourceCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if _looks_like_user_authored_note(body):
        raise HTTPException(
            status_code=422,
            detail="This content looks like user-authored or agent-authored writing. Save it as a Note or Writing document instead of a Source.",
        )

    if body.source_type == "web" and body.url and not (body.raw_content or "").strip():
        try:
            page = await fetch_web_page(body.url)
        except WebPageFetchError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        metadata = dict(body.metadata or {})
        metadata.update(page.metadata)
        body.raw_content = page.text
        body.url = page.final_url
        if page.title and _is_placeholder_or_url_title(body.title):
            body.title = page.title
        body.metadata = metadata

    source = await persist_source(session=session, body=body, user_id=user.id)
    if is_url_backed_source(source):
        try:
            await maybe_enable_rss_for_source(source, auto_fetch=True, session=session)
            await session.commit()
            await session.refresh(source)
        except Exception:
            logger.info("RSS auto-discovery failed for source %s", source.id, exc_info=True)
    return source


@router.post("/{source_id}/download-pdf", response_model=SourceRead, status_code=201)
async def download_source_pdf(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    metadata = source.metadata_ or {}
    pdf_url = metadata.get("pdf_url") or metadata.get("download_url")
    if not isinstance(pdf_url, str) or not pdf_url.strip():
        raise HTTPException(status_code=422, detail="This source does not have a downloadable PDF link")

    if metadata.get("downloaded_pdf_source_id"):
        existing = await session.get(Source, str(metadata["downloaded_pdf_source_id"]))
        if existing and existing.user_id == user.id:
            return existing

    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        response = await client.get(pdf_url)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "pdf" not in content_type.lower() and not pdf_url.lower().endswith(".pdf"):
            raise HTTPException(status_code=422, detail="Download URL did not return a PDF")
        pdf_bytes = response.content

    filename = _pdf_filename_from_url(pdf_url, source.title)
    extracted_text = await extract_text_content(filename, "application/pdf", pdf_bytes, pdf_type=None)
    object_key = get_storage_service().build_object_key("sources", source.id, filename)
    storage_uri = await get_storage_service().upload_bytes(
        object_key=object_key,
        data=pdf_bytes,
        content_type="application/pdf",
    )

    pdf_source = await persist_source(
        session=session,
        body=SourceCreate(
            id=f"{source.id}-pdf",
            title=f"{source.title} (PDF)",
            category_id=source.category_id,
            source_type="pdf",
            url=pdf_url,
            raw_content=extracted_text,
            file_path=storage_uri,
            metadata={
                "origin": "downloaded_pdf",
                "downloaded_from_source_id": source.id,
                "source_connector": metadata.get("connector"),
                "review_status": "imported_reviewable",
                "retention": "permanent",
                "kept_at": datetime.now(timezone.utc).isoformat(),
                "content_type": "application/pdf",
                "extraction_mode": "llm_markdown",
                "extraction_status": "completed" if extracted_text else "missing_text",
            },
        ),
        user_id=user.id,
        file_path=storage_uri,
        raw_content_override=extracted_text,
        content_hash_override=hashlib.sha256(pdf_bytes).hexdigest(),
    )

    source.metadata_ = {**metadata, "downloaded_pdf_source_id": pdf_source.id, "downloaded_pdf_at": datetime.now(timezone.utc).isoformat()}
    await session.commit()
    await session.refresh(source)
    return pdf_source


@router.post("/upload", response_model=SourceUploadResult, status_code=201)
async def upload_source(
    response: Response,
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

    content_hash = hashlib.sha256(payload).hexdigest()
    existing = await find_owned_uploaded_source_by_hash(
        session,
        user_id=user.id,
        content_hash=content_hash,
    )
    if existing:
        response.status_code = 200
        return SourceUploadResult(
            **SourceRead.model_validate(existing).model_dump(),
            created=False,
            duplicate=True,
        )

    inferred_title = title or Path(file.filename or "source").stem
    extracted_text = await extract_text_content(file.filename, file.content_type, payload, pdf_type=pdf_type)
    suffix = Path(file.filename or "").suffix.lower()
    extraction_mode = (
        "pymupdf" if suffix == ".pdf" and pdf_type == "text"
        else "vlm" if suffix == ".pdf" and pdf_type == "vlm"
        else "docling_ocr" if suffix == ".pdf" and pdf_type == "ocr"
        else "direct" if (file.content_type or "").startswith("text/") or suffix in TEXT_FILE_SUFFIXES
        else "docling"
    )
    body = SourceCreate(
        title=inferred_title,
        source_type=source_type,
        category_id=category_id,
        url=url,
        raw_content=extracted_text,
        metadata={
            "extraction_status": "completed" if extracted_text else "missing_text",
            "extraction_mode": extraction_mode,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
        },
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

    source = await persist_source(
        session=session,
        body=body.model_copy(update={"id": source_id, "file_path": storage_uri}),
        user_id=user.id,
        file_path=storage_uri,
        raw_content_override=body.raw_content,
        content_hash_override=content_hash,
    )
    return SourceUploadResult(
        **SourceRead.model_validate(source).model_dump(),
        created=True,
        duplicate=False,
    )


@router.get("", response_model=SourceList)
async def list_sources(
    source_type: str | None = None,
    category_id: int | None = None,
    kind: str | None = None,
    feed_view: str = Query(default="parents", pattern=r"^(parents|all|articles|feeds|snapshots)$"),
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    ownership = or_(Source.user_id == user.id, Source.is_shared)
    stmt = select(Source).where(ownership)
    count_stmt = select(func.count()).select_from(Source).where(ownership)

    if category_id is not None:
        stmt = stmt.where(Source.category_id == category_id)
        count_stmt = count_stmt.where(Source.category_id == category_id)
    if source_type:
        stmt = stmt.where(Source.source_type == source_type)
        count_stmt = count_stmt.where(Source.source_type == source_type)
    if kind:
        kind_filter = text("metadata->>'kind' = :kind")
        stmt = stmt.where(kind_filter).params(kind=kind)
        count_stmt = count_stmt.where(kind_filter).params(kind=kind)

    if feed_view == "parents":
        no_parent = text("NOT (metadata ? 'feed_source_id')")
        stmt = stmt.where(no_parent)
        count_stmt = count_stmt.where(no_parent)
    elif feed_view == "articles":
        is_article = text("metadata ? 'feed_source_id'")
        stmt = stmt.where(is_article)
        count_stmt = count_stmt.where(is_article)
    elif feed_view == "feeds":
        is_feed = text("metadata->>'rss_enabled' = 'true'")
        stmt = stmt.where(is_feed)
        count_stmt = count_stmt.where(is_feed)
    elif feed_view == "snapshots":
        snapshot = text("NOT (metadata ? 'feed_source_id') AND COALESCE(metadata->>'rss_enabled', '') <> 'true'")
        stmt = stmt.where(Source.source_type.in_(["web", "article"]), snapshot)
        count_stmt = count_stmt.where(Source.source_type.in_(["web", "article"]), snapshot)

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


async def read_source_by_id(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> SourceRead:
    source = await session.get(Source, source_id)
    if not source or (source.user_id != user.id and not source.is_shared):
        raise HTTPException(status_code=404, detail="Source not found")
    category = await session.get(Category, source.category_id)
    result = SourceRead.model_validate(source)
    result.category_name = category.name if category else None
    return result


@router.get("/{source_id}", response_model=SourceRead)
async def get_source(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await read_source_by_id(source_id, user=user, session=session)


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
        if key == "metadata":
            source.metadata_ = value
            continue
        setattr(source, key, value)

    source.metadata_ = apply_source_retention(source.source_type, source.metadata_)

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


@router.get("/{source_id}/chunk-count")
async def get_source_chunk_count(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or (source.user_id != user.id and not source.is_shared):
        raise HTTPException(status_code=404, detail="Source not found")
    result = await session.execute(
        select(func.count()).select_from(SourceChunk).where(SourceChunk.source_id == source_id)
    )
    return {"count": result.scalar() or 0}


@router.post("/{source_id}/review/keep", response_model=SourceRead)
async def keep_imported_source(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    metadata = dict(source.metadata_ or {})
    if metadata.get("review_status") != "imported_reviewable":
        raise HTTPException(status_code=409, detail="Source is not pending imported-source review")
    metadata["review_status"] = "reviewed_kept"
    metadata["reviewed_at"] = datetime.now(timezone.utc).isoformat()
    metadata["retention"] = "permanent"
    metadata.setdefault("kept_at", metadata["reviewed_at"])
    source.metadata_ = metadata
    await sync_discovery_review_for_source(session, source=source, status="saved")

    await session.commit()
    await session.refresh(source)

    category = await session.get(Category, source.category_id)
    result = SourceRead.model_validate(source)
    result.category_name = category.name if category else None
    return result


async def delete_source_by_id(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")

    await sync_discovery_review_for_source(session, source=source, status="dismissed")

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


@router.delete("/{source_id}", status_code=204)
async def delete_source(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    await delete_source_by_id(source_id, user=user, session=session)


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


@router.post("/{source_id}/retry-extraction", response_model=SourceRead)
async def retry_source_extraction(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")
    if not source.file_path:
        raise HTTPException(status_code=422, detail="Source has no stored file to re-extract")

    if source.file_path.startswith("minio://"):
        payload = await get_storage_service().get_object(source.file_path)
        filename = Path(source.file_path).name
    else:
        local_path = Path(source.file_path).resolve()
        allowed_root = Path(settings.DATA_DIR).resolve()
        if not local_path.is_relative_to(allowed_root):
            raise HTTPException(status_code=403, detail="Access denied")
        if not local_path.exists():
            raise HTTPException(status_code=404, detail="Source file not found")
        payload = await asyncio.to_thread(local_path.read_bytes)
        filename = local_path.name

    extracted_text = await extract_text_content(filename, None, payload, pdf_type=None)
    source.raw_content = (extracted_text or "").replace("\x00", "") or None
    metadata = dict(source.metadata_ or {})
    metadata["extraction_mode"] = "llm_markdown"
    metadata["extraction_status"] = "completed" if extracted_text else "missing_text"
    metadata["extracted_at"] = datetime.now(timezone.utc).isoformat()
    source.metadata_ = metadata

    index_succeeded = await upsert_source_embeddings(session, source)
    metadata["index_status"] = "completed" if index_succeeded else "failed"
    metadata["indexed_at"] = datetime.now(timezone.utc).isoformat()
    source.metadata_ = metadata
    await session.commit()
    await session.refresh(source)
    return source


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
    if source.source_type not in {"web", "article"}:
        raise HTTPException(status_code=422, detail="RSS can only be enabled on URL-backed web/article sources")
    if not source.url:
        raise HTTPException(status_code=422, detail="Source must have a URL to enable RSS")

    discovered = await discover_rss_feed(source.url)
    if not discovered:
        raise HTTPException(status_code=422, detail="Cannot find a valid RSS feed for this URL")

    meta = dict(source.metadata_ or {})
    meta["rss_enabled"] = "true"
    meta["feed_title"] = discovered["feed_title"]
    meta["feed_url"] = discovered["feed_url"]
    meta["entries_available"] = discovered["entries_available"]
    meta["feed_auto_detected"] = False
    if discovered["feed_url"] != source.url:
        source.url = discovered["feed_url"]
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

    from pkg.services.foundation.rss_fetcher import fetch_single_feed

    new_count = await fetch_single_feed(source, session)
    return {"new_articles": new_count}


@router.post("/{source_id}/web/discover")
async def discover_web_articles_now(
    source_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Discover same-directory article links from a web directory source and import them."""
    source = await session.get(Source, source_id)
    if not source or source.user_id != user.id:
        raise HTTPException(status_code=404, detail="Source not found")
    if source.source_type != "web" or not source.url:
        raise HTTPException(status_code=422, detail="Web discovery requires a URL-backed web source")

    from pkg.services.foundation.web_directory import import_web_directory_articles

    result = await import_web_directory_articles(session, source, limit=limit)
    meta = dict(source.metadata_ or {})
    meta["web_directory_enabled"] = True
    meta["web_directory_last_discovered"] = result.discovered
    meta["web_directory_last_imported"] = result.imported
    meta["web_directory_last_updated"] = result.updated
    meta["web_directory_last_skipped"] = result.skipped
    meta["web_directory_last_fetch_at"] = datetime.now(timezone.utc).isoformat()
    source.metadata_ = meta
    await session.commit()
    await session.refresh(source)
    return {"discovered": result.discovered, "imported": result.imported, "updated": result.updated, "skipped": result.skipped}


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
    ownership = or_(Source.user_id == user.id, Source.is_shared)

    count_stmt = (
        select(func.count())
        .select_from(Source)
        .where(ownership, base_filter.bindparams(feed_id=source_id))
    )
    total = (await session.execute(count_stmt)).scalar() or 0

    stmt = (
        select(Source)
        .where(ownership, base_filter.bindparams(feed_id=source_id))
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
    from pkg.services.foundation.rss_summarizer import summarize_rss_by_topic

    note_ids = await summarize_rss_by_topic()
    return {"note_ids": note_ids, "count": len(note_ids)}


@router.get("/{source_id:path}", response_model=SourceRead)
async def get_source_legacy_path_id(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Read legacy sources whose ids accidentally contain slash characters."""
    return await read_source_by_id(source_id, user=user, session=session)


@router.delete("/{source_id:path}", status_code=204)
async def delete_source_legacy_path_id(
    source_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Delete legacy sources whose ids accidentally contain slash characters."""
    await delete_source_by_id(source_id, user=user, session=session)
