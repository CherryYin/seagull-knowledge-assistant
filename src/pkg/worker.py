import logging
import os

from pkg.config import settings
from pkg.services.cross_cutting.scheduler import get_scheduled_tasks, scheduled_pipeline_loop
from pkg.services.cross_cutting.system_jobs import mark_stale_running_jobs_failed


logger = logging.getLogger(__name__)


def background_tasks_disabled() -> bool:
    return os.environ.get("KG_DISABLE_BACKGROUND_TASKS", "").lower() in {"1", "true", "yes"}


async def run_worker(*, poll_interval_seconds: int = 30) -> None:
    if background_tasks_disabled():
        logger.info("Background worker disabled by KG_DISABLE_BACKGROUND_TASKS.")
        return

    try:
        recovered = await mark_stale_running_jobs_failed()
        if recovered:
            logger.warning(
                "Recovered %d stale running system job(s) left by a previous worker.",
                recovered,
            )
    except Exception:
        logger.exception("Failed to recover stale running system jobs during worker startup")

    for task in get_scheduled_tasks():
        if not task.enabled:
            logger.info("Scheduled task %s disabled.", task.name)

    if settings.RSS_AUTO_SUMMARY_ENABLED:
        logger.warning(
            "RSS_AUTO_SUMMARY_ENABLED is ignored: RSS summary is now an optional downstream action, not an independent scheduled task."
        )
    if settings.DISCOVERY_AUTO_GENERATE_ENABLED:
        logger.warning(
            "DISCOVERY_AUTO_GENERATE_ENABLED is ignored: Discovery generation is now triggered by collection flows or explicit refresh, not an independent scheduled task."
        )

    await scheduled_pipeline_loop(poll_interval_seconds=poll_interval_seconds)
