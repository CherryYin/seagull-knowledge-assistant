from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.connector_cache import ConnectorSearchItem
from pkg.services.foundation.connector_cache import (
    cleanup_expired_connector_cache,
    delete_expired_connector_search_items,
    mark_connector_item_saved,
)


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


@pytest.mark.asyncio
async def test_mark_connector_item_saved_closes_matching_discovery_review():
    session = AsyncMock()
    cached = ConnectorSearchItem(
        user_id="user-1",
        provider="github",
        item_key="owner/repo",
        title="owner/repo",
        status="cached",
        payload={},
    )
    cached_rows = MagicMock()
    cached_rows.scalar_one_or_none.return_value = cached
    session.execute.side_effect = [cached_rows, MagicMock()]

    result = await mark_connector_item_saved(
        session,
        user_id="user-1",
        provider="github",
        item_key="owner/repo",
        source_id="src-github-owner-repo",
    )

    assert result is cached
    assert cached.status == "saved"
    update_sql = str(session.execute.await_args_list[1].args[0])
    assert "UPDATE discovery_items" in update_sql
    assert "discovery_items.item_key =" in update_sql
