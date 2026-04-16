import hashlib
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.api.categories import get_default_category_id
from pkg.api.notes import make_note_id, persist_note, put_note_markdown_oss
from pkg.api.sources import extract_text_content, make_source_id, persist_source
from pkg.schemas.knowledge import RememberRequest, SaveDocumentRequest, SaveDocumentResponse
from pkg.schemas.note import NoteCreate, NoteRead
from pkg.schemas.source import SourceCreate
from pkg.services.storage import get_storage_service

logger = logging.getLogger(__name__)

router = APIRouter()

_FORMAT_TO_SOURCE_TYPE: dict[str, str] = {
    "docx": "article",
    "xlsx": "code",
    "pptx": "article",
    "pdf": "pdf",
    "md": "article",
}


@router.post("/save-document", response_model=SaveDocumentResponse, status_code=201)
async def save_document(body: SaveDocumentRequest, session: AsyncSession = Depends(get_session)):
    """Save a generated document as a Source + Note."""
    storage = get_storage_service()
    category_id = body.category_id or await get_default_category_id(session)

    # Download the file bytes from OSS via storage URI
    bucket, object_key = storage.parse_storage_uri(body.storage_uri)
    try:
        resp = storage.client.get_object(Bucket=bucket, Key=object_key)
        payload = resp["Body"].read()
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Cannot read document from storage: {exc}")

    # Create Source record
    source_type = _FORMAT_TO_SOURCE_TYPE.get(body.document_format, "article")
    raw_content = extract_text_content(body.document_filename, None, payload)

    source_body = SourceCreate(
        title=Path(body.document_filename).stem.replace("-", " ").replace("_", " ").title(),
        source_type=source_type,
        category_id=category_id,
        raw_content=raw_content,
        file_path=body.storage_uri,
    )
    source = await persist_source(
        session=session,
        body=source_body,
        file_path=body.storage_uri,
        raw_content_override=raw_content,
        content_hash_override=hashlib.sha256(payload).hexdigest(),
    )

    # Create Note record linked to the source
    note_title = Path(body.document_filename).stem.replace("-", " ").replace("_", " ").title()
    note_body = NoteCreate(
        title=note_title,
        note_type="concept",
        category_id=category_id,
        content=body.message_content,
        source_ids=[source.id],
        status="seed",
        tags=["from-document"],
    )
    note_id = make_note_id(note_body.title)
    storage_uri = put_note_markdown_oss(note_id, body.message_content)
    note = await persist_note(
        session=session,
        body=note_body.model_copy(update={"id": note_id}),
        file_path=storage_uri,
        content_override=body.message_content,
    )

    return SaveDocumentResponse(source_id=source.id, note_id=note.id)


@router.post("/remember", response_model=NoteRead, status_code=201)
async def remember_knowledge(body: RememberRequest, session: AsyncSession = Depends(get_session)):
    """Save assistant response as a temporary note for later daily summarization."""
    title = body.title or body.content.replace("\n", " ").strip()[:40] or "Chat memory"
    category_id = body.category_id or await get_default_category_id(session)

    note_body = NoteCreate(
        title=title,
        note_type="inbox",
        category_id=category_id,
        content=body.content,
        status="temporary",
        tags=["auto-remember"],
        domains=["chat-memory"],
    )
    note_id = make_note_id(note_body.title)
    storage_uri = put_note_markdown_oss(note_id, body.content)
    note = await persist_note(
        session=session,
        body=note_body.model_copy(update={"id": note_id}),
        file_path=storage_uri,
        content_override=body.content,
    )
    return note


@router.post("/summarize-daily")
async def trigger_daily_summary():
    """Manually trigger the daily temporary notes summarization."""
    from pkg.services.daily_summarizer import summarize_temporary_notes

    note_id = await summarize_temporary_notes()
    if note_id is None:
        return {"status": "skipped", "detail": "No temporary notes to summarize"}
    return {"status": "ok", "note_id": note_id}
