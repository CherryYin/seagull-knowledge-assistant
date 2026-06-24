import logging
from datetime import datetime, timezone

from sqlalchemy import select

from pkg.db import async_session
from pkg.models.user import User
from pkg.services.cross_cutting.system_jobs import cleanup_system_jobs
from pkg.services.cross_cutting.retention import cleanup_discovery_items, cleanup_review_suggestions, cleanup_wiki_mining_runs
from pkg.services.cross_cutting.storage_audit import run_storage_orphan_audit_step
from pkg.services.foundation.connector_cache import cleanup_expired_connector_cache
from pkg.services.foundation.rss_fetcher import cleanup_old_rss_articles
from pkg.api.notes import delete_expired_digest_notes

logger = logging.getLogger(__name__)


async def run_maintenance_cleanup_step() -> dict:
    stats = {
        "digest_notes_deleted": 0,
        "rss_articles_deleted": 0,
        "system_jobs_deleted": 0,
        "discovery_items_deleted": 0,
        "review_suggestions_deleted": 0,
        "wiki_mining_runs_deleted": 0,
        "connector_cache_deleted": 0,
        "storage_orphan_audit": None,
        "errors": 0,
    }

    try:
        async with async_session() as session:
            rows = await session.execute(select(User.id))
            user_ids = list(rows.scalars())
            now = datetime.now(timezone.utc)
            for user_id in user_ids:
                before = len(session.deleted)
                await delete_expired_digest_notes(session, user_id=user_id, now=now)
                stats["digest_notes_deleted"] += max(len(session.deleted) - before, 0)
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during digest note cleanup")

    try:
        stats["rss_articles_deleted"] = await cleanup_old_rss_articles()
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during RSS cleanup")

    try:
        stats["system_jobs_deleted"] = await cleanup_system_jobs()
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during system jobs cleanup")

    try:
        stats["discovery_items_deleted"] = await cleanup_discovery_items()
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during discovery retention cleanup")

    try:
        stats["review_suggestions_deleted"] = await cleanup_review_suggestions()
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during review suggestion retention cleanup")

    try:
        stats["wiki_mining_runs_deleted"] = await cleanup_wiki_mining_runs()
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during wiki mining retention cleanup")

    try:
        async with async_session() as session:
            stats["connector_cache_deleted"] = await cleanup_expired_connector_cache(session)
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during connector cache cleanup")

    try:
        stats["storage_orphan_audit"] = await run_storage_orphan_audit_step()
    except Exception:
        stats["errors"] += 1
        logger.exception("Maintenance cleanup failed during storage orphan audit")

    return stats
