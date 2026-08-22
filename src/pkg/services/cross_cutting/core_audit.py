from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.note import Note
from pkg.models.foundation.wiki import WikiPage, WikiRecompileSuggestion


def _audit_section(ids: list[str | int], *, id_limit: int) -> dict[str, Any]:
    return {
        "count": len(ids),
        "ids": ids[:id_limit],
        "ids_truncated": len(ids) > id_limit,
    }


async def collect_core_simplification_audit(
    session: AsyncSession,
    *,
    now: datetime | None = None,
    id_limit: int = 1000,
) -> dict[str, Any]:
    """Collect a read-only Phase A audit without loading knowledge content."""
    if id_limit < 0:
        raise ValueError("id_limit must be non-negative")

    audit_time = now or datetime.now(timezone.utc)
    expired_digest_rows = await session.execute(
        select(Note.id, Note.file_path)
        .where(
            Note.note_type == "digest",
            Note.status == "pending_review",
            Note.expires_at.is_not(None),
            Note.expires_at < audit_time,
        )
        .order_by(Note.id)
    )
    discovery_rows = await session.execute(
        select(DiscoveryItem.id)
        .where(DiscoveryItem.status == "recommended")
        .order_by(DiscoveryItem.id)
    )
    stale_wiki_rows = await session.execute(
        select(WikiPage.id)
        .where(WikiPage.needs_recompile.is_(True))
        .order_by(WikiPage.id)
    )
    wiki_suggestion_rows = await session.execute(
        select(WikiRecompileSuggestion.id)
        .where(WikiRecompileSuggestion.status == "pending")
        .order_by(WikiRecompileSuggestion.id)
    )

    expired_digest_records = list(expired_digest_rows.all())
    expired_digest_ids = [record[0] for record in expired_digest_records]
    digest_storage_uris = [
        record[1]
        for record in expired_digest_records
        if isinstance(record[1], str) and record[1].startswith("minio://")
    ]
    discovery_ids = list(discovery_rows.scalars())
    stale_wiki_ids = list(stale_wiki_rows.scalars())
    wiki_suggestion_ids = list(wiki_suggestion_rows.scalars())

    return {
        "generated_at": audit_time.isoformat(),
        "read_only": True,
        "expired_digest_notes": {
            **_audit_section(expired_digest_ids, id_limit=id_limit),
            "storage_object_count": len(digest_storage_uris),
            "storage_uris": digest_storage_uris[:id_limit],
            "storage_uris_truncated": len(digest_storage_uris) > id_limit,
        },
        "discovery_backlog": _audit_section(discovery_ids, id_limit=id_limit),
        "wiki_queue": {
            "stale_pages": _audit_section(stale_wiki_ids, id_limit=id_limit),
            "pending_recompile_suggestions": _audit_section(wiki_suggestion_ids, id_limit=id_limit),
        },
    }
