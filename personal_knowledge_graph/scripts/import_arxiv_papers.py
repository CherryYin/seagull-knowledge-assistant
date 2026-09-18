"""Search/import arXiv papers as article sources.

Examples:
    python scripts/import_arxiv_papers.py --query "retrieval augmented generation" --limit 5 --dry-run
    python scripts/import_arxiv_papers.py --paper-id 2401.00001 --user-id <user_id>
    python scripts/import_arxiv_papers.py --query "agentic rag" --category cs.AI --user-id <user_id> --limit 3
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.db import async_session
from pkg.services.foundation.connectors import import_arxiv_paper, search_arxiv

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import arXiv papers into Sources.")
    parser.add_argument("--user-id", help="Owner user id for imported sources")
    parser.add_argument("--query", help="Search query")
    parser.add_argument("--author", help="Author filter")
    parser.add_argument("--category", help="arXiv category, e.g. cs.AI")
    parser.add_argument("--paper-id", help="Specific arXiv paper id")
    parser.add_argument("--date-from", help="Submitted date lower bound YYYY-MM-DD")
    parser.add_argument("--date-to", help="Submitted date upper bound YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=5, help="Max papers to search/import")
    parser.add_argument("--category-id", type=int, default=1, help="Local source category id")
    parser.add_argument("--dry-run", action="store_true", help="Search only; do not write")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    papers = await search_arxiv(
        query=args.query,
        author=args.author,
        category=args.category,
        paper_id=args.paper_id,
        date_from=args.date_from,
        date_to=args.date_to,
        max_results=args.limit,
    )
    logger.info("Found %d arXiv paper(s)", len(papers))
    if args.dry_run or not args.user_id:
        for paper in papers:
            logger.info("%s | %s", paper.arxiv_id, paper.title)
        if not args.user_id and not args.dry_run:
            logger.warning("--user-id is required to import; showing dry-run results only")
        return

    created = updated = 0
    async with async_session() as session:
        for paper in papers:
            source, was_created, dedupe_key = await import_arxiv_paper(
                session,
                user_id=args.user_id,
                paper=paper,
                category_id=args.category_id,
            )
            logger.info("%s %s -> %s", "created" if was_created else "updated", dedupe_key, source.id)
            created += int(was_created)
            updated += int(not was_created)
        await session.commit()
    logger.info("Done. created=%d updated=%d", created, updated)


if __name__ == "__main__":
    asyncio.run(main())
