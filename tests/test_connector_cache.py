from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.services.foundation.connector_cache import cleanup_expired_connector_cache, delete_expired_connector_search_items


@pytest.mark.asyncio
async def test_cleanup_expired_connector_cache_deletes_unsaved_expired_items():
    session = AsyncMock()
    result = MagicMock()
    result.rowcount = 4
    session.execute.return_value = result

    deleted = await cleanup_expired_connector_cache(session, now=datetime(2026, 6, 13, tzinfo=timezone.utc))

    assert deleted == 4
    stmt = session.execute.await_args.args[0]
    sql = str(stmt)
    assert "DELETE FROM connector_search_items" in sql
    assert "connector_search_items.status !=" in sql
    assert "connector_search_items.expires_at IS NOT NULL" in sql
    assert "connector_search_items.expires_at <" in sql
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_expired_connector_search_items_can_scope_by_user_and_provider():
    session = AsyncMock()
    result = MagicMock()
    result.rowcount = 1
    session.execute.return_value = result

    deleted = await delete_expired_connector_search_items(
        session,
        user_id="user-1",
        provider="github",
        now=datetime(2026, 6, 13, tzinfo=timezone.utc),
    )

    assert deleted == 1
    stmt = session.execute.await_args.args[0]
    sql = str(stmt)
    assert "connector_search_items.user_id =" in sql
    assert "connector_search_items.provider =" in sql
