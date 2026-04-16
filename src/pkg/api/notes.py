from datetime import datetime, timezone
from pathlib import Path

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.models.category import Category
from pkg.models.note import Note, NoteEmbedding
from pkg.schemas.note import NoteCreate, NoteList, NoteRead, NoteUpdate
from pkg.services.embedding import get_embedding_service
from pkg.services.storage import get_storage_service

router = APIRouter()
logger = logging.getLogger(__name__)


def split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def make_note_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    return f"note-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}"


def put_note_markdown_oss(note_id: str, content: str, category_name: str | None = None) -> str:
    """Upload note body to MinIO at notes/{category_name}/{note_id}/note.md. put_object overwrites an existing object."""
    storage = get_storage_service()
    object_key = storage.build_object_key("notes", note_id, "note.md", category_name=category_name)
    return storage.upload_bytes(
        object_key=object_key,
        data=(content or "").encode("utf-8"),
        content_type="text/markdown",
    )


async def persist_note(
    *,
    session: AsyncSession,
    body: NoteCreate,
    file_path: str | None = None,
    content_override: str | None = None,
) -> Note:
    note_id = make_note_id(body.title, body.id)

    note = Note(
        id=note_id,
        category_id=body.category_id,
        title=body.title,
        note_type=body.note_type,
        domains=body.domains,
        tags=body.tags,
        abstract=body.abstract,
        content=content_override if content_override is not None else body.content,
        project=body.project,
        status=body.status,
        confidence=body.confidence,
        source_ids=body.source_ids,
        file_path=file_path,
        word_count=len(((content_override if content_override is not None else body.content) or "").split()),
    )
    session.add(note)

    emb_svc = get_embedding_service()
    title_vec = emb_svc.embed_text(note.title)
    abstract_vec = emb_svc.embed_text(body.abstract or body.title)
    session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))

    await session.commit()
    await session.refresh(note)
    return note


@router.post("", response_model=NoteRead, status_code=201)
async def create_note(body: NoteCreate, session: AsyncSession = Depends(get_session)):
    note_id = make_note_id(body.title, body.id)
    content = body.content or ""
    category = await session.get(Category, body.category_id)
    category_name = category.name if category else None
    storage_uri = put_note_markdown_oss(note_id, content, category_name=category_name)
    return await persist_note(
        session=session,
        body=body.model_copy(update={"id": note_id}),
        file_path=storage_uri,
        content_override=content,
    )


@router.post("/upload", response_model=NoteRead, status_code=201)
async def upload_note(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    note_type: str = Form("inbox"),
    category_id: int = Form(1),
    domains: str | None = Form(None),
    tags: str | None = Form(None),
    abstract: str | None = Form(None),
    project: str | None = Form(None),
    status: str = Form("seed"),
    confidence: str = Form("medium"),
    source_ids: str | None = Form(None),
    session: AsyncSession = Depends(get_session),
):
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded note file is empty")

    inferred_title = title or Path(file.filename or "note").stem
    content = file_bytes.decode("utf-8", errors="replace")
    body = NoteCreate(
        title=inferred_title,
        note_type=note_type,
        category_id=category_id,
        domains=split_csv(domains),
        tags=split_csv(tags),
        abstract=abstract,
        project=project,
        status=status,
        confidence=confidence,
        source_ids=split_csv(source_ids),
        content=content,
    )

    note_id = make_note_id(body.title, body.id)
    category = await session.get(Category, category_id)
    category_name = category.name if category else None
    storage = get_storage_service()
    object_key = storage.build_object_key("notes", note_id, file.filename, category_name=category_name)
    storage_uri = storage.upload_bytes(
        object_key=object_key,
        data=file_bytes,
        content_type=file.content_type,
    )

    return await persist_note(
        session=session,
        body=body.model_copy(update={"id": note_id}),
        file_path=storage_uri,
        content_override=content,
    )


@router.get("", response_model=NoteList)
async def list_notes(
    note_type: str | None = None,
    category_id: int | None = None,
    domain: str | None = None,
    tag: str | None = None,
    project: str | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Note)
    count_stmt = select(func.count()).select_from(Note)

    if category_id is not None:
        stmt = stmt.where(Note.category_id == category_id)
        count_stmt = count_stmt.where(Note.category_id == category_id)
    if note_type:
        stmt = stmt.where(Note.note_type == note_type)
        count_stmt = count_stmt.where(Note.note_type == note_type)
    if domain:
        stmt = stmt.where(Note.domains.any(domain))
        count_stmt = count_stmt.where(Note.domains.any(domain))
    if tag:
        stmt = stmt.where(Note.tags.any(tag))
        count_stmt = count_stmt.where(Note.tags.any(tag))
    if project:
        stmt = stmt.where(Note.project == project)
        count_stmt = count_stmt.where(Note.project == project)
    if status:
        stmt = stmt.where(Note.status == status)
        count_stmt = count_stmt.where(Note.status == status)

    stmt = stmt.order_by(Note.updated_at.desc()).offset(offset).limit(limit)

    total = (await session.execute(count_stmt)).scalar() or 0
    rows = await session.execute(stmt)
    items = list(rows.scalars())

    # Populate category_name
    cat_ids = {n.category_id for n in items}
    cat_map: dict[int, str] = {}
    if cat_ids:
        cat_rows = await session.execute(select(Category).where(Category.id.in_(cat_ids)))
        cat_map = {c.id: c.name for c in cat_rows.scalars()}

    result_items = []
    for n in items:
        read = NoteRead.model_validate(n)
        read.category_name = cat_map.get(n.category_id)
        result_items.append(read)

    return NoteList(items=result_items, total=total)


@router.patch("/{note_id}", response_model=NoteRead)
@router.put("/{note_id}", response_model=NoteRead)
async def update_note(
    note_id: str,
    body: NoteUpdate,
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    patch = body.model_dump(exclude_unset=True)
    if not patch:
        return note

    for key, value in patch.items():
        setattr(note, key, value)

    note.word_count = len((note.content or "").split())
    # Look up category name for OSS path
    category = await session.get(Category, note.category_id)
    category_name = category.name if category else None
    # Always persist current body to OSS (overwrites if present).
    note.file_path = put_note_markdown_oss(note_id, note.content or "", category_name=category_name)

    title_or_abstract_changed = "title" in patch or "abstract" in patch
    if title_or_abstract_changed:
        emb_svc = get_embedding_service()
        emb_row = await session.get(NoteEmbedding, note_id)
        title_vec = emb_svc.embed_text(note.title)
        abstract_vec = emb_svc.embed_text(note.abstract or note.title)
        if emb_row:
            emb_row.title_vec = title_vec
            emb_row.abstract_vec = abstract_vec
        else:
            session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))

    await session.commit()
    await session.refresh(note)
    return note


@router.get("/{note_id}", response_model=NoteRead)
async def get_note(note_id: str, session: AsyncSession = Depends(get_session)):
    note = await session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    category = await session.get(Category, note.category_id)
    result = NoteRead.model_validate(note)
    result.category_name = category.name if category else None
    return result


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: str, session: AsyncSession = Depends(get_session)):
    note = await session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    # Delete stored file from MinIO
    if note.file_path and note.file_path.startswith("minio://"):
        try:
            get_storage_service().delete_object(note.file_path)
        except Exception:
            logger.warning("Failed to delete MinIO object for note %s: %s", note_id, note.file_path, exc_info=True)

    # Delete related embedding
    emb = await session.get(NoteEmbedding, note_id)
    if emb:
        await session.delete(emb)

    await session.delete(note)
    await session.commit()


@router.get("/{note_id}/file")
async def get_note_file(note_id: str, session: AsyncSession = Depends(get_session)):
    note = await session.get(Note, note_id)
    if not note or not note.file_path:
        raise HTTPException(status_code=404, detail="Note file not found")

    if note.file_path.startswith("minio://"):
        url = get_storage_service().generate_download_url(note.file_path)
        return RedirectResponse(url=url)

    local_path = Path(note.file_path)
    if not local_path.exists():
        raise HTTPException(status_code=404, detail="Note file not found")
    return FileResponse(local_path)
