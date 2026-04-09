import hashlib
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.models.source import Source, SourceEmbedding
from pkg.schemas.source import SourceCreate, SourceList, SourceRead
from pkg.services.embedding import get_embedding_service
from pkg.services.storage import get_storage_service

router = APIRouter()

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


def _make_source_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    return f"src-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}"


def _extract_text_content(filename: str | None, content_type: str | None, payload: bytes) -> str | None:
    suffix = Path(filename or "").suffix.lower()
    if (content_type or "").startswith("text/") or suffix in TEXT_FILE_SUFFIXES:
        return payload.decode("utf-8", errors="replace")
    return None


async def _persist_source(
    *,
    session: AsyncSession,
    body: SourceCreate,
    file_path: str | None = None,
    raw_content_override: str | None = None,
    content_hash_override: str | None = None,
) -> Source:
    source_id = _make_source_id(body.title, body.id)
    raw_content = raw_content_override if raw_content_override is not None else body.raw_content
    content_hash = content_hash_override or hashlib.sha256((raw_content or "").encode()).hexdigest()

    source = Source(
        id=source_id,
        title=body.title,
        source_type=body.source_type,
        url=body.url,
        raw_content=raw_content,
        file_path=file_path or body.file_path,
        content_hash=content_hash,
        metadata_=body.metadata,
    )
    session.add(source)

    emb_svc = get_embedding_service()
    title_vec = emb_svc.embed_text(source.title)
    summary_vec = emb_svc.embed_text(raw_content[:500] if raw_content else source.title)
    session.add(SourceEmbedding(source_id=source_id, title_vec=title_vec, summary_vec=summary_vec))

    await session.commit()
    await session.refresh(source)
    return source


@router.post("", response_model=SourceRead, status_code=201)
async def create_source(body: SourceCreate, session: AsyncSession = Depends(get_session)):
    return await _persist_source(session=session, body=body)


@router.post("/upload", response_model=SourceRead, status_code=201)
async def upload_source(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    source_type: str = Form("article"),
    url: str | None = Form(None),
    session: AsyncSession = Depends(get_session),
):
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded source file is empty")

    inferred_title = title or Path(file.filename or "source").stem
    body = SourceCreate(
        title=inferred_title,
        source_type=source_type,
        url=url,
        raw_content=_extract_text_content(file.filename, file.content_type, payload),
    )

    source_id = _make_source_id(body.title, body.id)
    storage = get_storage_service()
    object_key = storage.build_object_key("sources", source_id, file.filename)
    storage_uri = storage.upload_bytes(
        object_key=object_key,
        data=payload,
        content_type=file.content_type,
    )

    return await _persist_source(
        session=session,
        body=body.model_copy(update={"id": source_id, "file_path": storage_uri}),
        file_path=storage_uri,
        raw_content_override=body.raw_content,
        content_hash_override=hashlib.sha256(payload).hexdigest(),
    )


@router.get("", response_model=SourceList)
async def list_sources(
    source_type: str | None = None,
    limit: int = 20,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Source)
    count_stmt = select(func.count()).select_from(Source)

    if source_type:
        stmt = stmt.where(Source.source_type == source_type)
        count_stmt = count_stmt.where(Source.source_type == source_type)

    stmt = stmt.order_by(Source.ingested_at.desc()).offset(offset).limit(limit)

    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    items = list(rows.scalars())

    return SourceList(items=items, total=total)


@router.get("/{source_id}", response_model=SourceRead)
async def get_source(source_id: str, session: AsyncSession = Depends(get_session)):
    source = await session.get(Source, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    return source


@router.get("/{source_id}/file")
async def get_source_file(source_id: str, session: AsyncSession = Depends(get_session)):
    source = await session.get(Source, source_id)
    if not source or not source.file_path:
        raise HTTPException(status_code=404, detail="Source file not found")

    if source.file_path.startswith("minio://"):
        url = get_storage_service().generate_download_url(source.file_path)
        return RedirectResponse(url=url)

    local_path = Path(source.file_path)
    if not local_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
    return FileResponse(local_path)
