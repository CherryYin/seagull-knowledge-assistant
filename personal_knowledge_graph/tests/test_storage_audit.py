from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.storage_audit import collect_referenced_object_uris, run_storage_orphan_audit_step


class _ScalarRows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_collect_referenced_object_uris_normalizes_and_filters_values():
    session = AsyncMock()
    session.execute.side_effect = [
        _ScalarRows(["minio://bucket/sources/a.pdf", "/tmp/local.txt", None]),
        _ScalarRows(["minio://bucket/notes/b.md"]),
        _ScalarRows([
            {"storage_uri": "minio://bucket/assets/c.md"},
            {"file_path": "minio://bucket/assets/d.md"},
            {"storage_uri": "https://example.com/nope"},
        ]),
    ]

    with patch("pkg.services.cross_cutting.storage_audit.async_session") as session_factory:
        session_factory.return_value.__aenter__.return_value = session
        result = await collect_referenced_object_uris()

    assert result == {
        "minio://bucket/sources/a.pdf",
        "minio://bucket/notes/b.md",
        "minio://bucket/assets/c.md",
        "minio://bucket/assets/d.md",
    }


@pytest.mark.asyncio
async def test_run_storage_orphan_audit_step_reports_orphan_samples():
    storage = MagicMock()
    storage.list_object_uris = AsyncMock(return_value=[
        "minio://bucket/sources/a.pdf",
        "minio://bucket/notes/b.md",
        "minio://bucket/orphans/x.bin",
    ])

    with (
        patch("pkg.services.cross_cutting.storage_audit.get_storage_service", return_value=storage),
        patch("pkg.services.cross_cutting.storage_audit.collect_referenced_object_uris", AsyncMock(return_value={
            "minio://bucket/sources/a.pdf",
            "minio://bucket/notes/b.md",
        })),
    ):
        result = await run_storage_orphan_audit_step()

    assert result["referenced_count"] == 2
    assert result["object_count"] == 3
    assert result["orphan_count"] == 1
    assert result["orphan_samples"] == ["minio://bucket/orphans/x.bin"]
    assert result["delete_enabled"] is False


@pytest.mark.asyncio
async def test_run_storage_orphan_audit_step_reports_no_orphans_reason():
    storage = MagicMock()
    storage.list_object_uris = AsyncMock(return_value=["minio://bucket/sources/a.pdf"])

    with (
        patch("pkg.services.cross_cutting.storage_audit.get_storage_service", return_value=storage),
        patch("pkg.services.cross_cutting.storage_audit.collect_referenced_object_uris", AsyncMock(return_value={"minio://bucket/sources/a.pdf"})),
    ):
        result = await run_storage_orphan_audit_step()

    assert result["orphan_count"] == 0
    assert result["reason"] == "no_orphan_objects"
