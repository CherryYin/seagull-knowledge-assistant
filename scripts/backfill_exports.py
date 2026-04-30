"""Backfill old OSS exports into the DB as Source + Note records with 'from-document' tag.

Usage:
    poetry run python scripts/backfill_exports.py
"""
import asyncio
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


async def main():
    from pkg.config import settings
    from pkg.db import async_session
    from pkg.models.note import Note, NoteEmbedding
    from pkg.models.source import Source
    from pkg.services.embedding import get_embedding_service
    from pkg.services.storage import get_storage_service

    storage = get_storage_service()
    emb_svc = get_embedding_service()

    resp = storage.client.list_objects_v2(Bucket=storage.bucket, Prefix="exports/")
    objects = resp.get("Contents", [])
    if not objects:
        logger.info("No objects found under exports/")
        return

    # Get user_id from DB (first admin user)
    async with async_session() as session:
        from sqlalchemy import select, text
        from pkg.models.user import User

        result = await session.execute(select(User).limit(1))
        user = result.scalar_one_or_none()
        if not user:
            logger.error("No users in DB — cannot assign ownership")
            return
        user_id = user.id

        # Get default category_id
        from pkg.models.category import Category
        cat_result = await session.execute(select(Category).limit(1))
        cat = cat_result.scalar_one_or_none()
        category_id = cat.id if cat else None

        created = 0
        skipped = 0

        for obj in objects:
            key = obj["Key"]  # e.g. "exports/儿子暑期课程时间表.docx"
            filename = Path(key).name
            storage_uri = storage.to_storage_uri(key)

            # Check if a note with this storage_uri already exists (via source)
            existing = await session.execute(
                select(Source).where(Source.file_path == storage_uri)
            )
            if existing.scalar_one_or_none():
                logger.info("SKIP (source exists): %s", filename)
                skipped += 1
                continue

            # Download file
            try:
                data = storage.client.get_object(Bucket=storage.bucket, Key=key)["Body"].read()
            except Exception as exc:
                logger.warning("Cannot read %s: %s", key, exc)
                skipped += 1
                continue

            title = Path(filename).stem.replace("-", " ").replace("_", " ")
            fmt = Path(filename).suffix.lstrip(".")
            content_hash = hashlib.sha256(data).hexdigest()
            now = datetime.now(timezone.utc)

            # Extract text
            raw_content = ""
            if fmt == "docx":
                try:
                    from docx import Document
                    import io
                    doc = Document(io.BytesIO(data))
                    raw_content = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
                except Exception:
                    raw_content = f"[Document: {filename}]"
            else:
                raw_content = f"[Document: {filename}]"

            # Create Source
            src_id = f"src-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}-{uuid.uuid4().hex[:8]}"
            source = Source(
                id=src_id,
                user_id=user_id,
                category_id=category_id,
                title=title,
                source_type="article",
                raw_content=raw_content,
                content_hash=content_hash,
                file_path=storage_uri,
            )
            session.add(source)

            # Create Note
            note_id = f"note-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}-{uuid.uuid4().hex[:8]}"
            note = Note(
                id=note_id,
                user_id=user_id,
                category_id=category_id,
                title=title,
                note_type="concept",
                tags=["from-document"],
                content=raw_content[:2000] if raw_content else "",
                status="seed",
                source_ids=[src_id],
                file_path=storage_uri,
                word_count=len(raw_content.split()) if raw_content else 0,
            )
            session.add(note)

            # Create embeddings
            title_vec = await emb_svc.embed_text(title)
            abstract_vec = await emb_svc.embed_text(title)
            session.add(NoteEmbedding(note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec))

            await session.commit()
            logger.info("CREATED: %s -> note=%s, source=%s", filename, note_id, src_id)
            created += 1

        logger.info("Done. Created: %d, Skipped: %d", created, skipped)


if __name__ == "__main__":
    asyncio.run(main())
