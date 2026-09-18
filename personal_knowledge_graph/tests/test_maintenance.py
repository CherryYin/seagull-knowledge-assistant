from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.maintenance import (
    cleanup_expired_digest_notes_all_users,
    run_maintenance_cleanup_step,
)


class _ScalarRows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_run_maintenance_cleanup_step_aggregates_counts():
    connector_session = AsyncMock()
    connector_session.deleted = []

    with (
        patch("pkg.services.cross_cutting.maintenance.async_session") as session_factory,
        patch(
            "pkg.services.cross_cutting.maintenance.cleanup_expired_digest_notes_all_users",
            AsyncMock(return_value={
                "users_checked": 2,
                "notes_deleted": 2,
                "storage_objects_deleted": 2,
                "storage_delete_errors": 0,
            }),
        ),
        patch("pkg.services.cross_cutting.maintenance.cleanup_old_rss_articles", AsyncMock(return_value=8)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_system_jobs", AsyncMock(return_value=120)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_discovery_items", AsyncMock(return_value=12)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_review_suggestions", AsyncMock(return_value=9)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_expired_connector_cache", AsyncMock(return_value=44)),
        patch("pkg.services.cross_cutting.maintenance.run_storage_orphan_audit_step", AsyncMock(return_value={"orphan_count": 2})),
    ):
        session_factory.return_value = MagicMock(
            __aenter__=AsyncMock(return_value=connector_session),
            __aexit__=AsyncMock(return_value=None),
        )

        result = await run_maintenance_cleanup_step()

    assert result == {
        "digest_notes_deleted": 2,
        "digest_storage_objects_deleted": 2,
        "digest_storage_delete_errors": 0,
        "rss_articles_deleted": 8,
        "system_jobs_deleted": 120,
        "discovery_items_deleted": 12,
        "review_suggestions_deleted": 9,
        "connector_cache_deleted": 44,
        "storage_orphan_audit": {"orphan_count": 2},
        "errors": 0,
    }


@pytest.mark.asyncio
async def test_run_maintenance_cleanup_step_isolates_failures():
    connector_session = AsyncMock()
    connector_session.deleted = []

    with (
        patch("pkg.services.cross_cutting.maintenance.async_session") as session_factory,
        patch(
            "pkg.services.cross_cutting.maintenance.cleanup_expired_digest_notes_all_users",
            AsyncMock(side_effect=RuntimeError("digest boom")),
        ),
        patch("pkg.services.cross_cutting.maintenance.cleanup_old_rss_articles", AsyncMock(side_effect=RuntimeError("rss boom"))),
        patch("pkg.services.cross_cutting.maintenance.cleanup_system_jobs", AsyncMock(return_value=9)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_discovery_items", AsyncMock(side_effect=RuntimeError("discovery boom"))),
        patch("pkg.services.cross_cutting.maintenance.cleanup_review_suggestions", AsyncMock(return_value=4)),
        patch("pkg.services.cross_cutting.maintenance.cleanup_expired_connector_cache", AsyncMock(side_effect=RuntimeError("cache boom"))),
        patch("pkg.services.cross_cutting.maintenance.run_storage_orphan_audit_step", AsyncMock(side_effect=RuntimeError("storage boom"))),
    ):
        session_factory.return_value = MagicMock(
            __aenter__=AsyncMock(return_value=connector_session),
            __aexit__=AsyncMock(return_value=None),
        )

        result = await run_maintenance_cleanup_step()

    assert result["digest_notes_deleted"] == 0
    assert result["digest_storage_objects_deleted"] == 0
    assert result["digest_storage_delete_errors"] == 0
    assert result["rss_articles_deleted"] == 0
    assert result["system_jobs_deleted"] == 9
    assert result["discovery_items_deleted"] == 0
    assert result["review_suggestions_deleted"] == 4
    assert result["connector_cache_deleted"] == 0
    assert result["storage_orphan_audit"] is None
    assert result["errors"] == 5


@pytest.mark.asyncio
async def test_cleanup_expired_digest_notes_all_users_aggregates_exact_results():
    session = AsyncMock()
    session.execute.return_value = _ScalarRows(["user-1", "user-2"])
    session_cm = MagicMock(
        __aenter__=AsyncMock(return_value=session),
        __aexit__=AsyncMock(return_value=None),
    )
    cleanup = AsyncMock(side_effect=[
        {"notes_deleted": 2, "storage_objects_deleted": 2, "storage_delete_errors": 0},
        {"notes_deleted": 1, "storage_objects_deleted": 0, "storage_delete_errors": 1},
    ])

    with (
        patch("pkg.services.cross_cutting.maintenance.async_session", return_value=session_cm),
        patch("pkg.services.cross_cutting.maintenance.delete_expired_digest_notes", cleanup),
    ):
        result = await cleanup_expired_digest_notes_all_users()

    assert result == {
        "users_checked": 2,
        "notes_deleted": 3,
        "storage_objects_deleted": 2,
        "storage_delete_errors": 1,
    }
    assert cleanup.await_count == 2
