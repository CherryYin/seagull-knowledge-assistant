import hashlib
import logging
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.api.categories import get_default_category_id
from pkg.api.deps import get_current_user
from pkg.api.notes import make_note_id, persist_note, put_note_markdown_oss
from pkg.api.sources import make_source_id, persist_source
from pkg.schemas.knowledge import (
    RememberRequest,
    SaveDocumentRequest,
    SaveDocumentResponse,
)
from pkg.schemas.note import NoteCreate, NoteRead
from pkg.schemas.source import SourceCreate
from pkg.models.user import User
from pkg.services.storage import get_storage_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/save-document", response_model=SaveDocumentResponse, status_code=201)
async def save_document(
    body: SaveDocumentRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Save a generated document as MD — creates a Source + Note pair."""
    storage = get_storage_service()
    category_id = body.category_id or await get_default_category_id(session)

    title = body.title
    if not title and body.document_filename:
        title = Path(body.document_filename).stem.replace("-", " ").replace("_", " ").title()
    if not title:
        title = body.message_content.replace("\n", " ").strip()[:40] or "Untitled Document"

    raw_content = body.message_content

    source_id = make_source_id(title)
    md_object_key = f"exports/{source_id}.md"
    md_storage_uri = await storage.upload_bytes(
        object_key=md_object_key,
        data=raw_content.encode("utf-8"),
        content_type="text/markdown; charset=utf-8",
    )

    source_body = SourceCreate(
        title=title,
        source_type="article",
        category_id=category_id,
        raw_content=raw_content,
        file_path=md_storage_uri,
    )
    source = await persist_source(
        session=session,
        body=source_body.model_copy(update={"id": source_id}),
        user_id=user.id,
        file_path=md_storage_uri,
        raw_content_override=raw_content,
        content_hash_override=hashlib.sha256(raw_content.encode()).hexdigest(),
    )

    note_body = NoteCreate(
        title=title,
        note_type="concept",
        category_id=category_id,
        content=raw_content,
        source_ids=[source.id],
        status="seed",
        tags=["from-document"],
    )
    note_id = make_note_id(title)
    note_storage_uri = await put_note_markdown_oss(note_id, raw_content)
    note = await persist_note(
        session=session,
        body=note_body.model_copy(update={"id": note_id}),
        user_id=user.id,
        file_path=note_storage_uri,
        content_override=raw_content,
    )

    return SaveDocumentResponse(source_id=source.id, note_id=note.id)


@router.post("/remember", response_model=NoteRead, status_code=201)
async def remember_knowledge(
    body: RememberRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Save assistant response as a temporary note for later daily summarization."""
    title = body.title or body.content.replace("\n", " ").strip()[:40] or "Chat memory"
    category_id = body.category_id or await get_default_category_id(session)

    note_body = NoteCreate(
        title=title,
        note_type="remember",
        category_id=category_id,
        content=body.content,
        status="temporary",
        tags=["auto-remember"],
        domains=["chat-memory"],
    )
    note_id = make_note_id(note_body.title)
    storage_uri = await put_note_markdown_oss(note_id, body.content)
    note = await persist_note(
        session=session,
        body=note_body.model_copy(update={"id": note_id}),
        user_id=user.id,
        file_path=storage_uri,
        content_override=body.content,
    )
    return note


@router.post("/summarize-daily")
async def trigger_daily_summary(user: User = Depends(get_current_user)):
    """Manually trigger the daily temporary notes summarization."""
    from pkg.services.daily_summarizer import summarize_temporary_notes

    note_id = await summarize_temporary_notes(user.id)
    if note_id is None:
        return {"status": "skipped", "detail": "No temporary notes to summarize"}
    return {"status": "ok", "note_id": note_id}
