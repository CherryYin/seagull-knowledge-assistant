"""Discover and enable RSS feeds for historical web sources.

Usage:
    python scripts/discover_rss_sources.py
    python scripts/discover_rss_sources.py --dry-run
    python scripts/discover_rss_sources.py --limit 20 --auto-fetch
    python scripts/discover_rss_sources.py --user-id <user_id>
    python scripts/discover_rss_sources.py --source-id <source_id> --force
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.db import async_session
from pkg.services.foundation.rss_discovery import discover_rss_for_web_sources

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Discover RSS feeds for existing web sources.")
    parser.add_argument("--user-id", help="Only process sources owned by this user")
    parser.add_argument("--source-id", help="Only process one source")
    parser.add_argument("--limit", type=int, help="Maximum number of sources to process")
    parser.add_argument("--offset", type=int, default=0, help="Number of candidate sources to skip")
    parser.add_argument("--force", action="store_true", help="Retry sources even if RSS is already enabled")
    parser.add_argument("--dry-run", action="store_true", help="Show candidates without writing")
    parser.add_argument("--auto-fetch", action="store_true", help="Fetch articles immediately after enabling RSS")
    parser.add_argument("--commit-every", type=int, default=10, help="Commit after this many writes")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    async with async_session() as session:
        stats = await discover_rss_for_web_sources(
            session,
            user_id=args.user_id,
            source_id=args.source_id,
            limit=args.limit,
            offset=args.offset,
            force=args.force,
            dry_run=args.dry_run,
            auto_fetch=args.auto_fetch,
            commit_every=args.commit_every,
        )
    logger.info("Done. %s", stats)


if __name__ == "__main__":
    asyncio.run(main())
