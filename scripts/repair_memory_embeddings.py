"""Repair missing or stale MemoryEmbedding rows for MemoryNode records.

Usage:
    python scripts/repair_memory_embeddings.py --dry-run
    python scripts/repair_memory_embeddings.py --limit 20
    python scripts/repair_memory_embeddings.py --node-id <memory_node_id>
    python scripts/repair_memory_embeddings.py --force --limit 20
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from sqlalchemy import exists, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.db import async_session
from pkg.models.memory import MemoryEmbedding, MemoryNode
from pkg.services.memory_tree import upsert_memory_embedding

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair memory embedding rows.")
    parser.add_argument("--node-id", help="Only repair one memory node")
    parser.add_argument("--user-id", help="Only repair memory nodes owned by this user")
    parser.add_argument("--node-type", help="Only repair memory nodes of this type")
    parser.add_argument("--level", help="Only repair memory nodes at this level")
    parser.add_argument("--limit", type=int, help="Maximum number of memory nodes to process")
    parser.add_argument("--offset", type=int, default=0, help="Number of candidate memory nodes to skip")
    parser.add_argument("--force", action="store_true", help="Regenerate embeddings even if they already exist")
    parser.add_argument("--dry-run", action="store_true", help="Show candidates without writing")
    parser.add_argument("--commit-every", type=int, default=10, help="Commit after this many repaired rows")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if args.commit_every < 1:
        raise SystemExit("--commit-every must be >= 1")
    if args.limit is not None and args.limit < 1:
        raise SystemExit("--limit must be >= 1")
    if args.offset < 0:
        raise SystemExit("--offset must be >= 0")

    async with async_session() as session:
        stmt = _candidate_stmt(args)
        result = await session.execute(stmt)
        candidates = [
            {"id": node.id, "title": node.title, "node_type": node.node_type, "level": node.level}
            for node in result.scalars()
        ]

        if not candidates:
            logger.info("No memory embedding repair candidates found")
            return

        repaired = 0
        failed = 0
        pending_writes = 0
        logger.info("Processing %d memory embedding candidates", len(candidates))

        for candidate in candidates:
            node_id = candidate["id"]
            if args.dry_run:
                logger.info(
                    "DRY-RUN repair embedding: node=%s type=%s level=%s title=%s",
                    node_id,
                    candidate["node_type"],
                    candidate["level"],
                    candidate["title"],
                )
                repaired += 1
                continue

            try:
                node = await session.get(MemoryNode, node_id)
                if not node:
                    logger.info("SKIP missing memory node after reload: node=%s", node_id)
                    continue
                await upsert_memory_embedding(session, node)
                repaired += 1
                pending_writes += 1
                logger.info("Repaired memory embedding: node=%s", node_id)
            except Exception:
                failed += 1
                await session.rollback()
                pending_writes = 0
                logger.exception("FAILED memory embedding repair: node=%s", node_id)
                continue

            if pending_writes >= args.commit_every:
                await session.commit()
                pending_writes = 0

        if not args.dry_run and pending_writes:
            await session.commit()

        logger.info(
            "Done. Candidates=%d Repaired=%d Failed=%d Force=%s DryRun=%s",
            len(candidates),
            repaired,
            failed,
            args.force,
            args.dry_run,
        )


def _candidate_stmt(args: argparse.Namespace):
    stmt = select(MemoryNode)
    if args.node_id:
        stmt = stmt.where(MemoryNode.id == args.node_id)
    if args.user_id:
        stmt = stmt.where(MemoryNode.user_id == args.user_id)
    if args.node_type:
        stmt = stmt.where(MemoryNode.node_type == args.node_type)
    if args.level:
        stmt = stmt.where(MemoryNode.level == args.level)
    if not args.force:
        stmt = stmt.where(
            ~exists().where(MemoryEmbedding.memory_node_id == MemoryNode.id)
        )
    stmt = stmt.order_by(MemoryNode.updated_at.desc())
    if args.offset:
        stmt = stmt.offset(args.offset)
    if args.limit:
        stmt = stmt.limit(args.limit)
    return stmt


if __name__ == "__main__":
    asyncio.run(main())
