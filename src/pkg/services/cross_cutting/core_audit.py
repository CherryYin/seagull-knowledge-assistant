from datetime import datetime, timezone
from collections import Counter
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
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
    orphan_rows = await session.execute(
        select(MemoryNode.id, MemoryNode.metadata_)
        .outerjoin(
            Source,
            and_(
                Source.id == MemoryNode.scope_id,
                Source.user_id == MemoryNode.user_id,
            ),
        )
        .where(
            MemoryNode.node_type == "source",
            MemoryNode.level == "source",
            Source.id.is_(None),
        )
        .order_by(MemoryNode.id)
    )
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

    orphan_memory_records = list(orphan_rows.all())
    expired_digest_records = list(expired_digest_rows.all())
    orphan_memory_ids = [record[0] for record in orphan_memory_records]
    orphan_source_types = Counter(
        str((record[1] or {}).get("source_type") or "unknown")
        for record in orphan_memory_records
    )
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
        "orphan_source_memory": {
            **_audit_section(orphan_memory_ids, id_limit=id_limit),
            "by_source_type": dict(sorted(orphan_source_types.items())),
        },
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
