from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.retention import cleanup_discovery_items, cleanup_review_suggestions


@pytest.mark.asyncio
async def test_cleanup_discovery_items_deletes_old_terminal_items_only():
    session = AsyncMock()
    result = MagicMock()
    result.rowcount = 5
    session.execute.return_value = result

    with patch("pkg.services.cross_cutting.retention.async_session") as session_factory:
        session_factory.return_value.__aenter__.return_value = session
        deleted = await cleanup_discovery_items(retention_days=90)

    assert deleted == 5
    sql = str(session.execute.await_args.args[0])
    assert "DELETE FROM discovery_items" in sql
    assert "discovery_items.status IN" in sql
    assert "discovery_items.reviewed_at IS NOT NULL" in sql


@pytest.mark.asyncio
async def test_cleanup_review_suggestions_deletes_old_terminal_items_only():
    session = AsyncMock()
    result = MagicMock()
    result.rowcount = 7
    session.execute.return_value = result

    with patch("pkg.services.cross_cutting.retention.async_session") as session_factory:
        session_factory.return_value.__aenter__.return_value = session
        deleted = await cleanup_review_suggestions(retention_days=90)

    assert deleted == 7
    sql = str(session.execute.await_args.args[0])
    assert "DELETE FROM review_suggestions" in sql
    assert "review_suggestions.status IN" in sql
    assert "review_suggestions.reviewed_at IS NOT NULL" in sql


@pytest.mark.asyncio
