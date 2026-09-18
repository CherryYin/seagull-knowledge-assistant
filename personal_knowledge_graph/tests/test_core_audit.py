from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.services.cross_cutting.core_audit import collect_core_simplification_audit


def _rows(items):
    rows = MagicMock()
    rows.scalars.return_value = items
    rows.all.return_value = items
    return rows


@pytest.mark.asyncio
async def test_collect_core_simplification_audit_reports_ids_without_content():
    session = AsyncMock()
    session.execute.side_effect = [
        _rows([
            ("digest-a", "minio://knowledge-graph/notes/digest-a.md"),
        ]),
        _rows([10, 11, 12]),
        _rows(["wiki-a"]),
        _rows([20, 21]),
    ]
    now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)

    result = await collect_core_simplification_audit(session, now=now, id_limit=2)

    assert result == {
        "generated_at": "2026-08-22T12:00:00+00:00",
        "read_only": True,
        "expired_digest_notes": {
            "count": 1,
            "ids": ["digest-a"],
            "ids_truncated": False,
            "storage_object_count": 1,
            "storage_uris": ["minio://knowledge-graph/notes/digest-a.md"],
            "storage_uris_truncated": False,
        },
        "discovery_backlog": {
            "count": 3,
            "ids": [10, 11],
            "ids_truncated": True,
        },
        "wiki_queue": {
            "stale_pages": {
                "count": 1,
                "ids": ["wiki-a"],
                "ids_truncated": False,
            },
            "pending_recompile_suggestions": {
                "count": 2,
                "ids": [20, 21],
                "ids_truncated": False,
            },
        },
    }
    assert "content" not in repr(result).lower()


@pytest.mark.asyncio
async def test_collect_core_simplification_audit_rejects_negative_id_limit():
    with pytest.raises(ValueError, match="id_limit must be non-negative"):
        await collect_core_simplification_audit(AsyncMock(), id_limit=-1)
