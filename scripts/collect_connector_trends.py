"""Collect daily GitHub trend sources.

Examples:
    poetry run python scripts/collect_connector_trends.py --user-id <user_id>
    poetry run python scripts/collect_connector_trends.py --user-id <user_id> --date 2026-05-22
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.services.foundation.connector_trends import collect_daily_github_trends

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect daily GitHub trend sources.")
    parser.add_argument("--user-id", action="append", dest="user_ids", help="Target user id. Can be repeated. Defaults to configured/all active users.")
    parser.add_argument("--date", help="Trend date YYYY-MM-DD. Defaults to today UTC.")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    stats = await collect_daily_github_trends(user_ids=args.user_ids, trend_date=args.date)
    logger.info("Done. %s", stats)


if __name__ == "__main__":
    asyncio.run(main())
