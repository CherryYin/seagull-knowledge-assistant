"""Batch RSS discovery for historical URL-backed web/article sources."""

import logging

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.source import Source

logger = logging.getLogger(__name__)


async def discover_rss_for_web_sources(
    session: AsyncSession,
    *,
    user_id: str | None = None,
    source_id: str | None = None,
    limit: int | None = None,
    offset: int = 0,
    force: bool = False,
    dry_run: bool = False,
    auto_fetch: bool = False,
    commit_every: int = 10,
) -> dict[str, int]:
    """Discover RSS feeds for existing URL-backed web/article sources.

    Returns counts: candidates, enabled, not_found, skipped, failed.
    """
    if commit_every < 1:
        raise ValueError("commit_every must be >= 1")

    stmt = select(Source).where(
        Source.source_type.in_(["web", "article"]),
        Source.user_id.is_not(None),
        Source.url.is_not(None),
    )
    if user_id:
        stmt = stmt.where(Source.user_id == user_id)
    if source_id:
        stmt = stmt.where(Source.id == source_id)
    if not force:
        stmt = stmt.where(text("COALESCE(metadata->>'rss_enabled', '') <> 'true'"))
        stmt = stmt.where(text("NOT (metadata ? 'feed_source_id')"))
    if offset:
        stmt = stmt.offset(offset)
    if limit:
        stmt = stmt.limit(limit)
    stmt = stmt.order_by(Source.ingested_at.desc())

    rows = await session.execute(stmt)
    sources = list(rows.scalars())
    stats = {"candidates": len(sources), "enabled": 0, "not_found": 0, "skipped": 0, "failed": 0}
    pending = 0

    from pkg.api.sources import maybe_enable_rss_for_source

    for source in sources:
        source_id_value = source.id
        meta = dict(source.metadata_ or {})
        if not force and (meta.get("rss_enabled") == "true" or meta.get("feed_source_id")):
            stats["skipped"] += 1
            continue

        try:
            if dry_run:
                logger.info("DRY-RUN discover RSS: source=%s url=%s", source_id_value, source.url)
                continue
            enabled = await maybe_enable_rss_for_source(source, auto_fetch=auto_fetch, session=session)
            if enabled:
                stats["enabled"] += 1
                logger.info("Enabled RSS: source=%s feed_url=%s", source_id_value, source.url)
            else:
                stats["not_found"] += 1
                logger.info("No RSS feed found: source=%s", source_id_value)
            pending += 1
        except Exception:
            stats["failed"] += 1
            await session.rollback()
            pending = 0
            logger.exception("RSS discovery failed: source=%s", source_id_value)
            continue

        if pending >= commit_every:
            await session.commit()
            pending = 0

    if pending:
        await session.commit()
    return stats
