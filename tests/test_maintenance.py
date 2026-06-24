from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.maintenance import run_maintenance_cleanup_step


class _ScalarRows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_run_maintenance_cleanup_step_aggregates_counts():
    digest_session = AsyncMock()
    digest_session.deleted = [object(), object()]
    digest_session.execute.return_value = _ScalarRows(["user-1", "user-2"])

    connector_session = AsyncMock()
    connector_session.deleted = []

    delete_expired = AsyncMock(side_effect=lambda session, user_id, now=None: session.deleted.extend([user_id]))

    with (
        patch("pkg.services.cross_cutting.maintenance.async_session") as session_factory,
        patch("pkg.services.cross_cutting.maintenance.delete_expired_digest_notes", delete_expired),
        patch("pkg.services.cross_cutting.maintenance.cleanup_old_rss_articles", AsyncMock(return_value=8)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_system_jobs", AsyncMock(return_value=120)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_discovery_items", AsyncMock(return_value=12)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_review_suggestions", AsyncMock(return_value=9)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_wiki_mining_runs", AsyncMock(return_value=6)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_expired_connector_cache", AsyncMock(return_value=44)),
        patch("pkg.services.cross_cutting.maintenance.run_storage_orphan_audit_step", AsyncMock(return_value={"orphan_count": 2})),
    ):
        session_factory.side_effect = [
            MagicMock(__aenter__=AsyncMock(return_value=digest_session), __aexit__=AsyncMock(return_value=None)),
            MagicMock(__aenter__=AsyncMock(return_value=connector_session), __aexit__=AsyncMock(return_value=None)),
        ]

        result = await run_maintenance_cleanup_step()

    assert result == {
        "digest_notes_deleted": 2,
        "rss_articles_deleted": 8,
        "system_jobs_deleted": 120,
        "discovery_items_deleted": 12,
        "review_suggestions_deleted": 9,
        "wiki_mining_runs_deleted": 6,
        "connector_cache_deleted": 44,
        "storage_orphan_audit": {"orphan_count": 2},
        "errors": 0,
    }


@pytest.mark.asyncio
async def test_run_maintenance_cleanup_step_isolates_failures():
    digest_session = AsyncMock()
    digest_session.deleted = []
    digest_session.execute.return_value = _ScalarRows(["user-1"])

    connector_session = AsyncMock()
    connector_session.deleted = []

    with (
        patch("pkg.services.cross_cutting.maintenance.async_session") as session_factory,
        patch("pkg.services.cross_cutting.maintenance.delete_expired_digest_notes", AsyncMock(side_effect=RuntimeError("digest boom"))),
        patch("pkg.services.cross_cutting.maintenance.cleanup_old_rss_articles", AsyncMock(side_effect=RuntimeError("rss boom"))),
        patch("pkg.services.cross_cutting.maintenance.cleanup_system_jobs", AsyncMock(return_value=9)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_discovery_items", AsyncMock(side_effect=RuntimeError("discovery boom"))),
        patch("pkg.services.cross_cutting.maintenance.cleanup_review_suggestions", AsyncMock(return_value=4)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_wiki_mining_runs", AsyncMock(side_effect=RuntimeError("wiki boom"))),
        patch("pkg.services.cross_cutting.maintenance.cleanup_expired_connector_cache", AsyncMock(side_effect=RuntimeError("cache boom"))),
        patch("pkg.services.cross_cutting.maintenance.run_storage_orphan_audit_step", AsyncMock(side_effect=RuntimeError("storage boom"))),
    ):
        session_factory.side_effect = [
            MagicMock(__aenter__=AsyncMock(return_value=digest_session), __aexit__=AsyncMock(return_value=None)),
            MagicMock(__aenter__=AsyncMock(return_value=connector_session), __aexit__=AsyncMock(return_value=None)),
        ]

        result = await run_maintenance_cleanup_step()

    assert result["digest_notes_deleted"] == 0
    assert result["rss_articles_deleted"] == 0
    assert result["system_jobs_deleted"] == 9
    assert result["discovery_items_deleted"] == 0
    assert result["review_suggestions_deleted"] == 4
    assert result["wiki_mining_runs_deleted"] == 0
    assert result["connector_cache_deleted"] == 0
    assert result["storage_orphan_audit"] is None
    assert result["errors"] == 6
