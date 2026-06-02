"""Search/import GitHub repositories as code sources.

Examples:
    python scripts/import_github_repos.py --query "agent framework" --language Python --limit 5 --dry-run
    python scripts/import_github_repos.py --full-name openai/codex --user-id <user_id>
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.db import async_session
from pkg.services.connectors import get_github_repo, import_github_repo, search_github_repos

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import GitHub repos into Sources.")
    parser.add_argument("--user-id", help="Owner user id for imported sources")
    parser.add_argument("--query", help="GitHub repository search query")
    parser.add_argument("--full-name", help="Specific owner/repo to import")
    parser.add_argument("--language", help="Language qualifier")
    parser.add_argument("--topic", help="Topic qualifier")
    parser.add_argument("--min-stars", type=int, help="Minimum stars")
    parser.add_argument("--pushed-after", help="Pushed after YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=5, help="Max repos to search/import")
    parser.add_argument("--category-id", type=int, default=1, help="Local source category id")
    parser.add_argument("--no-readme", action="store_true", help="Do not fetch README for --full-name imports")
    parser.add_argument("--dry-run", action="store_true", help="Search only; do not write")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if args.full_name:
        repos = [await get_github_repo(args.full_name, fetch_readme=not args.no_readme)]
    else:
        if not args.query:
            raise SystemExit("--query or --full-name is required")
        repos = await search_github_repos(
            query=args.query,
            language=args.language,
            topic=args.topic,
            min_stars=args.min_stars,
            pushed_after=args.pushed_after,
            max_results=args.limit,
        )
    logger.info("Found %d GitHub repo(s)", len(repos))
    if args.dry_run or not args.user_id:
        for repo in repos:
            logger.info("%s | stars=%s | %s", repo.full_name, repo.stars, repo.description or "")
        if not args.user_id and not args.dry_run:
            logger.warning("--user-id is required to import; showing dry-run results only")
        return

    created = updated = 0
    async with async_session() as session:
        for repo in repos:
            if not repo.readme and not args.no_readme:
                repo = await get_github_repo(repo.full_name, fetch_readme=True)
            source, was_created, dedupe_key = await import_github_repo(
                session,
                user_id=args.user_id,
                repo=repo,
                category_id=args.category_id,
            )
            logger.info("%s %s -> %s", "created" if was_created else "updated", dedupe_key, source.id)
            created += int(was_created)
            updated += int(not was_created)
        await session.commit()
    logger.info("Done. created=%d updated=%d", created, updated)


if __name__ == "__main__":
    asyncio.run(main())
