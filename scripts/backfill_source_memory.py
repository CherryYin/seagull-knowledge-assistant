"""Backfill source-level MemoryNode records for historical Source rows.

Usage:
    python scripts/backfill_source_memory.py
    python scripts/backfill_source_memory.py --limit 20
    python scripts/backfill_source_memory.py --batch-short-sources --short-threshold 1000 --batch-size 20
    python scripts/backfill_source_memory.py --user-id <user_id>
    python scripts/backfill_source_memory.py --force
    python scripts/backfill_source_memory.py --dry-run
"""
import argparse
import asyncio
import logging
import sys
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.db import async_session
from pkg.models.memory import MemoryNode
from pkg.models.source import Source
from pkg.services.foundation.source_memory import (
    source_batch_memory_node_id,
    source_memory_node_id,
    upsert_source_batch_memory_node,
    upsert_source_memory_node,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill source-level memory nodes.")
    parser.add_argument("--user-id", help="Only backfill sources owned by this user")
    parser.add_argument("--source-id", help="Only backfill one source")
    parser.add_argument("--limit", type=int, help="Maximum number of sources to process")
    parser.add_argument("--offset", type=int, default=0, help="Number of candidate sources to skip")
    parser.add_argument("--force", action="store_true", help="Regenerate existing source memory nodes")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be processed without writing")
    parser.add_argument("--commit-every", type=int, default=5, help="Commit after this many writes")
    parser.add_argument("--batch-short-sources", action="store_true", help="Group short sources into batch memory nodes")
    parser.add_argument("--short-threshold", type=int, default=1000, help="Max raw_content chars for short-source batching")
    parser.add_argument("--min-content-chars", type=int, default=1, help="Skip sources with less content than this")
    parser.add_argument("--batch-size", type=int, default=20, help="Maximum short sources per batch memory node")
    parser.add_argument(
        "--group-by",
        default="feed_source_id,date",
        help="Comma-separated short-source grouping keys: feed_source_id, domain, date, source_type, user_id",
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if args.commit_every < 1:
        raise SystemExit("--commit-every must be >= 1")
    if args.short_threshold < 1:
        raise SystemExit("--short-threshold must be >= 1")
    if args.min_content_chars < 0:
        raise SystemExit("--min-content-chars must be >= 0")
    if args.batch_size < 2:
        raise SystemExit("--batch-size must be >= 2")

    async with async_session() as session:
        stmt = select(Source).where(Source.user_id.is_not(None)).order_by(Source.ingested_at.desc())
        if args.user_id:
            stmt = stmt.where(Source.user_id == args.user_id)
        if args.source_id:
            stmt = stmt.where(Source.id == args.source_id)
        if args.offset:
            stmt = stmt.offset(args.offset)
        if args.limit:
            stmt = stmt.limit(args.limit)

        result = await session.execute(stmt)
        sources = list(result.scalars())

        if not sources:
            logger.info("No matching sources found")
            return

        created = 0
        updated = 0
        batch_created = 0
        batch_updated = 0
        skipped = 0
        skipped_short = 0
        skipped_empty = 0
        failed = 0
        pending_writes = 0

        logger.info("Processing %d source candidates", len(sources))
        single_sources, batch_groups, pre_skipped = await _plan_sources(session, sources, args)
        skipped += pre_skipped["existing"]
        skipped_empty += pre_skipped["empty"]

        for source in single_sources:
            source_id = source["id"]
            source_title = source["title"]
            node_id = source_memory_node_id(source_id)
            existing = await session.get(MemoryNode, node_id)

            if existing and not args.force:
                logger.info("SKIP existing memory: source=%s node=%s", source_id, node_id)
                skipped += 1
                continue

            action = "UPDATE" if existing else "CREATE"
            if args.dry_run:
                logger.info("DRY-RUN %s: source=%s title=%s", action, source_id, source_title)
                if existing:
                    updated += 1
                else:
                    created += 1
                continue

            try:
                reloaded_source = await session.get(Source, source_id)
                if not reloaded_source:
                    skipped += 1
                    logger.info("SKIP missing source after reload: source=%s", source_id)
                    continue
                await upsert_source_memory_node(session, reloaded_source)
                pending_writes += 1
                if existing:
                    updated += 1
                else:
                    created += 1
                logger.info("%s source memory: source=%s node=%s", action, source_id, node_id)
            except Exception:
                failed += 1
                await session.rollback()
                pending_writes = 0
                logger.exception("FAILED source memory: source=%s", source_id)
                continue

            if pending_writes >= args.commit_every:
                await session.commit()
                pending_writes = 0

        for group_key, group_sources in batch_groups:
            if len(group_sources) < 2:
                skipped_short += len(group_sources)
                logger.info(
                    "SKIP short batch too small: group=%s count=%d",
                    group_key,
                    len(group_sources),
                )
                continue

            user_id = group_sources[0]["user_id"]
            source_ids = [source["id"] for source in group_sources]
            node_id = source_batch_memory_node_id(user_id, group_key, source_ids)
            existing = await session.get(MemoryNode, node_id)
            if existing and not args.force:
                logger.info("SKIP existing batch memory: group=%s node=%s", group_key, node_id)
                skipped += len(group_sources)
                continue

            action = "UPDATE" if existing else "CREATE"
            if args.dry_run:
                logger.info(
                    "DRY-RUN %s batch memory: group=%s sources=%d node=%s",
                    action,
                    group_key,
                    len(group_sources),
                    node_id,
                )
                if existing:
                    batch_updated += 1
                else:
                    batch_created += 1
                continue

            try:
                reloaded_sources = []
                for source_id in source_ids:
                    reloaded_source = await session.get(Source, source_id)
                    if reloaded_source:
                        reloaded_sources.append(reloaded_source)
                if len(reloaded_sources) < 2:
                    skipped_short += len(source_ids)
                    logger.info("SKIP batch after reload too small: group=%s", group_key)
                    continue
                await upsert_source_batch_memory_node(
                    session,
                    user_id=user_id,
                    group_key=group_key,
                    sources=reloaded_sources,
                )
                pending_writes += 1
                if existing:
                    batch_updated += 1
                else:
                    batch_created += 1
                logger.info(
                    "%s source batch memory: group=%s sources=%d node=%s",
                    action,
                    group_key,
                    len(group_sources),
                    node_id,
                )
            except Exception:
                failed += 1
                await session.rollback()
                pending_writes = 0
                logger.exception("FAILED source batch memory: group=%s", group_key)
                continue

            if pending_writes >= args.commit_every:
                await session.commit()
                pending_writes = 0

        if not args.dry_run and pending_writes:
            await session.commit()

        logger.info(
            "Done. SingleCreated=%d SingleUpdated=%d BatchCreated=%d BatchUpdated=%d "
            "Skipped=%d SkippedEmpty=%d SkippedShort=%d Failed=%d DryRun=%s",
            created,
            updated,
            batch_created,
            batch_updated,
            skipped,
            skipped_empty,
            skipped_short,
            failed,
            args.dry_run,
        )


async def _plan_sources(session, sources: list[Source], args: argparse.Namespace):
    single_sources: list[dict] = []
    grouped: dict[tuple[str, str], list[dict]] = {}
    skipped = {"existing": 0, "empty": 0}

    for source in sources:
        content_len = len((source.raw_content or "").strip())
        if content_len < args.min_content_chars:
            skipped["empty"] += 1
            logger.info("SKIP empty/too-short source: source=%s chars=%d", source.id, content_len)
            continue

        node_id = source_memory_node_id(source.id)
        existing = await session.get(MemoryNode, node_id)
        if existing and not args.force:
            logger.info("SKIP existing memory: source=%s node=%s", source.id, node_id)
            skipped["existing"] += 1
            continue

        if args.batch_short_sources and not args.force:
            existing_batch = await _find_existing_batch_memory(session, source.id)
            if existing_batch:
                logger.info(
                    "SKIP source already covered by batch memory: source=%s node=%s",
                    source.id,
                    existing_batch.id,
                )
                skipped["existing"] += 1
                continue

        if args.batch_short_sources and content_len <= args.short_threshold:
            group_key = _source_group_key(source, args.group_by)
            grouped.setdefault((source.user_id, group_key), []).append(_source_snapshot(source))
        else:
            single_sources.append(_source_snapshot(source))

    batch_groups: list[tuple[str, list[dict]]] = []
    for (_user_id, group_key), group_sources in grouped.items():
        for index in range(0, len(group_sources), args.batch_size):
            batch_groups.append((group_key, group_sources[index : index + args.batch_size]))

    logger.info(
        "Plan: singles=%d batch_groups=%d batched_sources=%d skipped_existing=%d skipped_empty=%d",
        len(single_sources),
        len(batch_groups),
        sum(len(group_sources) for _, group_sources in batch_groups),
        skipped["existing"],
        skipped["empty"],
    )
    return single_sources, batch_groups, skipped


async def _find_existing_batch_memory(session, source_id: str) -> MemoryNode | None:
    result = await session.execute(
        select(MemoryNode)
        .where(
            MemoryNode.node_type == "source",
            MemoryNode.level == "batch",
            MemoryNode.derived_from_sources.any(source_id),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


def _source_group_key(source: Source, group_by: str) -> str:
    fields = [field.strip() for field in group_by.split(",") if field.strip()]
    if not fields:
        fields = ["feed_source_id", "date"]
    parts = [_source_group_value(source, field) for field in fields]
    return "|".join(parts)


def _source_group_value(source: Source, field: str) -> str:
    metadata = source.metadata_ or {}
    if field == "feed_source_id":
        return f"feed:{metadata.get('feed_source_id') or _domain(source.url) or 'unknown'}"
    if field == "domain":
        return f"domain:{_domain(source.url) or 'unknown'}"
    if field == "date":
        ingested_at = source.ingested_at
        date_value = ingested_at.date().isoformat() if hasattr(ingested_at, "date") else "unknown"
        return f"date:{date_value}"
    if field == "source_type":
        return f"type:{source.source_type or 'unknown'}"
    if field == "user_id":
        return f"user:{source.user_id or 'unknown'}"
    return f"{field}:unknown"


def _domain(url: str | None) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    return parsed.netloc.lower().removeprefix("www.")


def _source_snapshot(source: Source) -> dict:
    return {
        "id": source.id,
        "title": source.title,
        "user_id": source.user_id,
    }


if __name__ == "__main__":
    asyncio.run(main())
