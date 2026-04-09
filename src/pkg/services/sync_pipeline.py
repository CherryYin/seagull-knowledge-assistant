import hashlib
from datetime import datetime, timezone
from pathlib import Path

import frontmatter
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.note import Note, NoteEmbedding
from pkg.models.source import Source, SourceEmbedding
from pkg.services.embedding import get_embedding_service


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def _generate_id(prefix: str, title: str, dt: datetime | None = None) -> str:
    dt = dt or datetime.now(timezone.utc)
    slug = title.lower().replace(" ", "-")[:40]
    return f"{prefix}-{dt.strftime('%Y%m%d')}-{slug}"


def _word_count(text: str | None) -> int:
    if not text:
        return 0
    return len(text.split())


async def sync_notes_from_directory(session: AsyncSession, notes_dir: Path) -> dict:
    stats = {"created": 0, "updated": 0, "skipped": 0}
    if not notes_dir.exists():
        return stats

    emb = get_embedding_service()

    for md_file in sorted(notes_dir.glob("**/*.md")):
        post = frontmatter.load(str(md_file))
        meta = post.metadata
        content = post.content

        note_id = meta.get("id") or _generate_id("note", meta.get("title", md_file.stem))
        file_hash = _content_hash(content)

        existing = await session.get(Note, note_id)
        if existing and existing.content and _content_hash(existing.content) == file_hash:
            stats["skipped"] += 1
            continue

        note = existing or Note(id=note_id)
        note.title = meta.get("title", md_file.stem)
        note.note_type = meta.get("type", meta.get("note_type", "inbox"))
        note.domains = meta.get("domains", [])
        note.tags = meta.get("tags", [])
        note.abstract = meta.get("abstract", "")
        note.content = content
        note.project = meta.get("project")
        note.status = meta.get("status", "seed")
        note.confidence = meta.get("confidence", "medium")
        note.source_ids = meta.get("source_ids", [])
        note.file_path = str(md_file)
        note.word_count = _word_count(content)
        note.updated_at = datetime.now(timezone.utc)

        if not existing:
            session.add(note)
            stats["created"] += 1
        else:
            stats["updated"] += 1

        # Generate embeddings
        title_vec = emb.embed_text(note.title)
        abstract_text = note.abstract or note.title
        abstract_vec = emb.embed_text(abstract_text)

        emb_row = await session.get(NoteEmbedding, note_id)
        if emb_row:
            emb_row.title_vec = title_vec
            emb_row.abstract_vec = abstract_vec
        else:
            session.add(NoteEmbedding(
                note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec
            ))

    await session.commit()
    return stats


async def sync_sources_from_directory(session: AsyncSession, sources_dir: Path) -> dict:
    stats = {"created": 0, "updated": 0, "skipped": 0}
    if not sources_dir.exists():
        return stats

    emb = get_embedding_service()

    for md_file in sorted(sources_dir.glob("**/*.md")):
        post = frontmatter.load(str(md_file))
        meta = post.metadata
        content = post.content

        source_id = meta.get("id") or _generate_id("src", meta.get("title", md_file.stem))
        file_hash = _content_hash(content)

        existing = await session.get(Source, source_id)
        if existing and existing.raw_content and _content_hash(existing.raw_content) == file_hash:
            stats["skipped"] += 1
            continue

        source = existing or Source(id=source_id)
        source.title = meta.get("title", md_file.stem)
        source.source_type = meta.get("type", meta.get("source_type", "article"))
        source.url = meta.get("url")
        source.content_hash = file_hash
        source.raw_content = content
        source.file_path = str(md_file)
        source.metadata_ = {k: v for k, v in meta.items() if k not in ("id", "title", "type", "source_type", "url")}

        if not existing:
            session.add(source)
            stats["created"] += 1
        else:
            stats["updated"] += 1

        # Generate embeddings
        title_vec = emb.embed_text(source.title)
        summary_text = meta.get("summary", source.title)
        summary_vec = emb.embed_text(summary_text)

        emb_row = await session.get(SourceEmbedding, source_id)
        if emb_row:
            emb_row.title_vec = title_vec
            emb_row.summary_vec = summary_vec
        else:
            session.add(SourceEmbedding(
                source_id=source_id, title_vec=title_vec, summary_vec=summary_vec
            ))

    await session.commit()
    return stats


def export_note_to_markdown(note: Note, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{note.id}.md"
    filepath = output_dir / filename

    meta = {
        "id": note.id,
        "title": note.title,
        "type": note.note_type,
        "domains": note.domains or [],
        "tags": note.tags or [],
        "status": note.status,
        "confidence": note.confidence,
    }
    if note.abstract:
        meta["abstract"] = note.abstract
    if note.project:
        meta["project"] = note.project
    if note.source_ids:
        meta["source_ids"] = note.source_ids

    post = frontmatter.Post(note.content or "", **meta)
    filepath.write_text(frontmatter.dumps(post), encoding="utf-8")
    return filepath
