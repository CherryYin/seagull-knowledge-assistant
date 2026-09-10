import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user, get_current_user_optional_token
from pkg.config import settings
from pkg.db import get_session
from pkg.models.category import Category
from pkg.models.foundation.note import Note, NoteEmbedding, NoteImage
from pkg.models.user import User
from pkg.schemas.note import DigestMergeRequest, NoteCreate, NoteImageResponse, NoteList, NoteRead, NoteUpdate, NoteVersion
from pkg.services.cross_cutting.embedding import get_embedding_service
from pkg.services.cross_cutting.storage import get_storage_service

router = APIRouter()
logger = logging.getLogger(__name__)

DIGEST_TTL_DAYS = 7
NOTE_MAX_VERSIONS = 20
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}


def digest_expires_at(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)) + timedelta(days=DIGEST_TTL_DAYS)


def apply_digest_retention(note: Note, *, now: datetime | None = None) -> None:
    if note.note_type != "digest":
        return
    if note.status == "pending_review":
        note.kept_at = None
        if getattr(note, "expires_at", None) is None:
            note.expires_at = digest_expires_at(now)
    else:
        note.expires_at = None
        if getattr(note, "kept_at", None) is None:
            note.kept_at = now or datetime.now(timezone.utc)



def push_content_version(note: Note, now: datetime | None = None) -> None:
    """Append the current (title, content) as a snapshot to ``content_versions``.

    Called when content/title actually changes during an update, so earlier
    states can be restored. Capped at NOTE_MAX_VERSIONS most-recent snapshots.
    """
    now = now or datetime.now(timezone.utc)
    versions = list(note.content_versions or [])
    versions.append({
        "title": note.title,
        "content": note.content or "",
        "created_at": now.isoformat(),
    })
    note.content_versions = versions[-NOTE_MAX_VERSIONS:]


async def delete_expired_digest_notes(
    session: AsyncSession,
    *,
    user_id: str,
    now: datetime | None = None,
) -> dict[str, int]:
    now = now or datetime.now(timezone.utc)
    storage = get_storage_service()
    rows = await session.execute(
        select(Note).where(
            Note.user_id == user_id,
            Note.note_type == "digest",
            Note.status == "pending_review",
            Note.expires_at.is_not(None),
            Note.expires_at < now,
        )
    )
    expired = list(rows.scalars())
    storage_objects_deleted = 0
    storage_delete_errors = 0
    for note in expired:
        file_path = (note.file_path or "").strip()
        if file_path.startswith("minio://"):
            try:
                await storage.delete_object(file_path)
                storage_objects_deleted += 1
            except Exception:
                storage_delete_errors += 1
                logger.warning("Failed to delete digest note object during expiry cleanup", extra={"note_id": note.id})
        emb = await session.get(NoteEmbedding, note.id)
        if emb:
            await session.delete(emb)
        await session.delete(note)
    if expired:
        await session.commit()
    return {
        "notes_deleted": len(expired),
        "storage_objects_deleted": storage_objects_deleted,
        "storage_delete_errors": storage_delete_errors,
    }


def split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def make_note_id(title: str, explicit_id: str | None = None) -> str:
    if explicit_id:
        return explicit_id
    now = datetime.now(timezone.utc)
    suffix = uuid.uuid4().hex[:8]
    return f"note-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}-{suffix}"


def _merge_unique(*values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for items in values:
        for item in items or []:
            if item and item not in seen:
                seen.add(item)
                merged.append(item)
    return merged


def _digest_entry(note: Note) -> str:
    date = note.created_at.strftime("%Y-%m-%d") if note.created_at else "unknown date"
    content = (note.content or "").strip() or "(empty digest)"
    return f"## {date} · {note.title}\n\n{content}"


async def put_note_markdown_oss(note_id: str, content: str, category_name: str | None = None) -> str:
    """Upload note body to MinIO at notes/{category_name}/{note_id}/note.md. put_object overwrites an existing object."""
    storage = get_storage_service()
    object_key = storage.build_object_key("notes", note_id, "note.md", category_name=category_name)
    return await storage.upload_bytes(
        object_key=object_key,
        data=(content or "").encode("utf-8"),
        content_type="text/markdown",
    )


async def persist_note(
    *,
    session: AsyncSession,
    body: NoteCreate,
    user_id: str,
    file_path: str | None = None,
    content_override: str | None = None,
) -> Note:
    tags = list(body.tags or [])
    if "from-agent" in tags and "agent-output" not in body.domains:
        body = body.model_copy(update={"domains": [*(body.domains or []), "agent-output"]})

    note_id = make_note_id(body.title, body.id)

    note = Note(
        id=note_id,
        user_id=user_id,
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
    apply_digest_retention(note)
    session.add(note)

    try:
        emb_svc = get_embedding_service()
        title_vec = await emb_svc.embed_text(note.title)
        abstract_vec = await emb_svc.embed_text(body.abstract or body.title)
        session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))
    except Exception:
        logger.error("Embedding generation failed for note %s — saving without embeddings", note_id, exc_info=True)

    await session.commit()
    await session.refresh(note)
    return note


@router.post("", response_model=NoteRead, status_code=201)
async def create_note(
    body: NoteCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note_id = make_note_id(body.title, body.id)
    content = body.content or ""
    category = await session.get(Category, body.category_id)
    category_name = category.name if category else None
    storage_uri = await put_note_markdown_oss(note_id, content, category_name=category_name)
    return await persist_note(
        session=session,
        body=body.model_copy(update={"id": note_id}),
        user_id=user.id,
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
    user: User = Depends(get_current_user),
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
    storage_uri = await storage.upload_bytes(
        object_key=object_key,
        data=file_bytes,
        content_type=file.content_type,
    )

    return await persist_note(
        session=session,
        body=body.model_copy(update={"id": note_id}),
        user_id=user.id,
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
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if note_type == "digest":
        await delete_expired_digest_notes(session, user_id=user.id)

    stmt = select(Note).where(Note.user_id == user.id)
    count_stmt = select(func.count()).select_from(Note).where(Note.user_id == user.id)

    if note_type is None:
        stmt = stmt.where(Note.note_type != "digest")
        count_stmt = count_stmt.where(Note.note_type != "digest")

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

    stmt = stmt.order_by(Note.is_pinned.desc(), Note.updated_at.desc()).offset(offset).limit(limit)

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


@router.post("/{note_id}/merge-digest", response_model=NoteRead)
async def merge_digest_notes(
    note_id: str,
    body: DigestMergeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    target = await session.get(Note, note_id)
    if not target or target.user_id != user.id or target.note_type != "digest":
        raise HTTPException(status_code=404, detail="Digest note not found")

    source_ids = [source_id for source_id in body.source_ids if source_id != note_id]
    if not source_ids:
        raise HTTPException(status_code=422, detail="Choose at least one different digest to merge")

    rows = await session.execute(
        select(Note).where(
            Note.user_id == user.id,
            Note.note_type == "digest",
            Note.id.in_(source_ids),
        )
    )
    sources = list(rows.scalars())
    if len(sources) != len(set(source_ids)):
        raise HTTPException(status_code=404, detail="One or more digest notes were not found")

    merge_parts = [_digest_entry(target)] + [_digest_entry(note) for note in sources]
    target.content = "\n\n---\n\n".join(merge_parts)
    if not target.abstract and sources:
        target.abstract = sources[0].abstract
    target.tags = _merge_unique(target.tags, *[note.tags for note in sources], ["merged-digest"])
    target.domains = _merge_unique(target.domains, *[note.domains for note in sources])
    target.source_ids = _merge_unique(target.source_ids, *[note.source_ids for note in sources])
    target.status = "kept"
    apply_digest_retention(target)
    target.word_count = len((target.content or "").split())

    category = await session.get(Category, target.category_id)
    category_name = category.name if category else None
    target.file_path = await put_note_markdown_oss(target.id, target.content or "", category_name=category_name)

    for source in sources:
        emb = await session.get(NoteEmbedding, source.id)
        if emb:
            await session.delete(emb)
        await session.delete(source)

    try:
        emb_svc = get_embedding_service()
        emb_row = await session.get(NoteEmbedding, target.id)
        title_vec = await emb_svc.embed_text(target.title)
        abstract_vec = await emb_svc.embed_text(target.abstract or target.title)
        if emb_row:
            emb_row.title_vec = title_vec
            emb_row.abstract_vec = abstract_vec
        else:
            session.add(NoteEmbedding(note_id=target.id, title_vec=title_vec, abstract_vec=abstract_vec))
    except Exception:
        logger.error("Embedding generation failed for merged digest %s", target.id, exc_info=True)

    await session.commit()
    await session.refresh(target)

    read = NoteRead.model_validate(target)
    read.category_name = category_name
    return read


@router.patch("/{note_id}", response_model=NoteRead)
@router.put("/{note_id}", response_model=NoteRead)
async def update_note(
    note_id: str,
    body: NoteUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")

    patch = body.model_dump(exclude_unset=True)
    if not patch:
        return note

    # Snapshot the pre-edit state when content or title is being changed, so it
    # can be restored from version history.
    if "content" in patch or "title" in patch:
        push_content_version(note)

    for key, value in patch.items():
        setattr(note, key, value)

    apply_digest_retention(note)
    note.word_count = len((note.content or "").split())
    # Look up category name for OSS path
    category = await session.get(Category, note.category_id)
    category_name = category.name if category else None
    # Always persist current body to OSS (overwrites if present).
    note.file_path = await put_note_markdown_oss(note_id, note.content or "", category_name=category_name)

    title_or_abstract_changed = "title" in patch or "abstract" in patch
    if title_or_abstract_changed:
        try:
            emb_svc = get_embedding_service()
            emb_row = await session.get(NoteEmbedding, note_id)
            title_vec = await emb_svc.embed_text(note.title)
            abstract_vec = await emb_svc.embed_text(note.abstract or note.title)
            if emb_row:
                emb_row.title_vec = title_vec
                emb_row.abstract_vec = abstract_vec
            else:
                session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))
        except Exception:
            logger.error("Embedding update failed for note %s", note_id, exc_info=True)

    await session.commit()
    await session.refresh(note)
    return note


@router.get("/{note_id}", response_model=NoteRead)
async def get_note(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")
    category = await session.get(Category, note.category_id)
    result = NoteRead.model_validate(note)
    result.category_name = category.name if category else None
    return result


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")

    # Delete stored file from MinIO
    if note.file_path and note.file_path.startswith("minio://"):
        try:
            await get_storage_service().delete_object(note.file_path)
        except Exception:
            logger.warning("Failed to delete MinIO object for note %s: %s", note_id, note.file_path, exc_info=True)

    # Delete related embedding
    emb = await session.get(NoteEmbedding, note_id)
    if emb:
        await session.delete(emb)

    await session.delete(note)
    await session.commit()


@router.get("/{note_id}/file")
async def get_note_file(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id or not note.file_path:
        raise HTTPException(status_code=404, detail="Note file not found")

    if note.file_path.startswith("minio://"):
        url = await get_storage_service().generate_download_url(note.file_path)
        return RedirectResponse(url=url)

    local_path = Path(note.file_path).resolve()
    allowed_root = Path(settings.DATA_DIR).resolve()
    if not local_path.is_relative_to(allowed_root):
        raise HTTPException(status_code=403, detail="Access denied")
    if not local_path.exists():
        raise HTTPException(status_code=404, detail="Note file not found")
    return FileResponse(local_path)


_PDF_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
@page {{ size: A4; margin: 2cm; }}
body {{
    font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC",
                 "Hiragino Sans GB", "Source Han Sans CN", sans-serif;
    font-size: 12pt;
    line-height: 1.8;
    color: #1a1a1a;
}}
h1 {{ font-size: 22pt; margin-top: 0; }}
h2 {{ font-size: 16pt; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }}
h3 {{ font-size: 13pt; }}
code {{
    font-family: "Fira Code", "Source Code Pro", "Noto Sans Mono CJK SC", monospace;
    background: #f5f5f5;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 10pt;
}}
pre {{
    background: #f5f5f5;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 10pt;
    line-height: 1.5;
}}
pre code {{ background: none; padding: 0; }}
.highlight pre {{ background: #f8f8f8; padding: 12px; border-radius: 4px; }}
table {{
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
}}
th, td {{
    border: 1px solid #ddd;
    padding: 8px 12px;
    text-align: left;
}}
th {{ background: #f5f5f5; font-weight: bold; }}
blockquote {{
    border-left: 3px solid #ddd;
    padding-left: 12px;
    color: #555;
    margin-left: 0;
}}
del {{ color: #999; text-decoration: line-through; }}
.task-list {{ list-style: none; padding-left: 0; }}
.task-list-item {{ position: relative; padding-left: 1.5em; }}
.task-list-control input[type="checkbox"] {{
    position: absolute; left: 0; top: 0.3em;
}}
</style>
</head>
<body>
<h1>{title}</h1>
{body}
</body>
</html>
"""

_PDF_ATX_HEADING = re.compile(r"^ {1,3}(#{1,6})([ \t]+\S.*)$")
_PDF_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def _normalize_pdf_markdown(content: str) -> str:
    lines = []
    fence_marker: str | None = None
    for line in content.splitlines(keepends=True):
        fence = _PDF_FENCE.match(line)
        if fence is not None:
            marker = fence.group(1)
            if fence_marker is None:
                fence_marker = marker
            elif marker[0] == fence_marker[0] and len(marker) >= len(fence_marker):
                fence_marker = None
            lines.append(line)
            continue
        if fence_marker is None:
            line = _PDF_ATX_HEADING.sub(r"\1\2", line)
        lines.append(line)
    return "".join(lines)


@router.get("/{note_id}/export/pdf")
async def export_note_pdf(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Export a note's markdown content as a PDF."""
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")

    content = note.content or ""
    if not content.strip():
        raise HTTPException(status_code=422, detail="Note has no content to export")

    import markdown as md
    from weasyprint import HTML

    html_body = md.markdown(
        _normalize_pdf_markdown(content),
        extensions=[
            "tables",
            "toc",
            "pymdownx.superfences",
            "pymdownx.tasklist",
            "pymdownx.tilde",
            "pymdownx.highlight",
            "pymdownx.inlinehilite",
        ],
        extension_configs={
            "pymdownx.highlight": {
                "use_pygments": True,
                "pygments_style": "default",
                "noclasses": True,
            },
            "pymdownx.tasklist": {
                "custom_checkbox": True,
            },
        },
    )
    full_html = _PDF_HTML_TEMPLATE.format(title=note.title, body=html_body)
    pdf_bytes = HTML(string=full_html).write_pdf()

    encoded_filename = quote(f"{note.title}.pdf")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=\"note.pdf\"; filename*=UTF-8''{encoded_filename}"},
    )


@router.post("/{note_id}/pin", response_model=NoteRead)
async def toggle_pin_note(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")
    note.is_pinned = not note.is_pinned
    await session.commit()
    await session.refresh(note)
    category = await session.get(Category, note.category_id)
    read = NoteRead.model_validate(note)
    read.category_name = category.name if category else None
    return read


@router.get("/{note_id}/versions", response_model=list[NoteVersion])
async def list_note_versions(
    note_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")
    versions = note.content_versions or []
    return [
        NoteVersion(index=idx, title=v.get("title"), content=v.get("content") or "", created_at=v.get("created_at"))
        for idx, v in enumerate(versions)
    ]


@router.post("/{note_id}/versions/{version_idx}/restore", response_model=NoteRead)
async def restore_note_version(
    note_id: str,
    version_idx: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")
    versions = note.content_versions or []
    if version_idx < 0 or version_idx >= len(versions):
        raise HTTPException(status_code=404, detail="Version not found")
    target = versions[version_idx]
    # Snapshot the current state before restoring, so the restore itself is reversible.
    push_content_version(note)
    note.content = target.get("content") or ""
    if target.get("title"):
        note.title = target["title"]
    apply_digest_retention(note)
    note.word_count = len((note.content or "").split())
    category = await session.get(Category, note.category_id)
    category_name = category.name if category else None
    note.file_path = await put_note_markdown_oss(note_id, note.content or "", category_name=category_name)
    await session.commit()
    await session.refresh(note)
    read = NoteRead.model_validate(note)
    read.category_name = category_name
    return read


@router.post("/{note_id}/images", response_model=NoteImageResponse, status_code=201)
async def upload_note_image(
    note_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Note not found")
    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported image type: {content_type or 'unknown'}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Image is empty")
    category = await session.get(Category, note.category_id)
    category_name = category.name if category else None
    storage = get_storage_service()
    image_id = f"img-{uuid.uuid4().hex[:12]}"
    ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
    }.get(content_type, "")
    filename = f"{image_id}{ext}"
    base_key = storage.build_object_key("notes", note_id, filename, category_name=category_name)
    object_key = base_key.replace(f"/{note_id}/", f"/{note_id}/images/", 1) if f"/{note_id}/" in base_key else base_key.replace(f"{note_id}/", f"{note_id}/images/", 1)
    storage_uri = await storage.upload_bytes(object_key=object_key, data=data, content_type=content_type)
    record = NoteImage(
        id=image_id,
        note_id=note_id,
        storage_uri=storage_uri,
        content_type=content_type,
        filename=file.filename,
    )
    session.add(record)
    await session.commit()
    return NoteImageResponse(
        id=image_id,
        note_id=note_id,
        url=f"/notes/{note_id}/images/{image_id}",
        content_type=content_type,
        filename=file.filename,
    )


@router.get("/{note_id}/images/{image_id}")
async def get_note_image(
    note_id: str,
    image_id: str,
    user: User = Depends(get_current_user_optional_token),
    session: AsyncSession = Depends(get_session),
):
    # Verify ownership of the note (image_id is not directly guessable, but the
    # note ownership check is the real guard).
    note = await session.get(Note, note_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status_code=404, detail="Image not found")
    image = await session.get(NoteImage, image_id)
    if not image or image.note_id != note_id:
        raise HTTPException(status_code=404, detail="Image not found")
    url = await get_storage_service().generate_download_url(image.storage_uri)
    return RedirectResponse(url=url)
