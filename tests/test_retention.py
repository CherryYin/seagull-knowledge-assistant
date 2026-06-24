from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.cross_cutting.retention import cleanup_discovery_items, cleanup_review_suggestions, cleanup_wiki_mining_runs


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
async def test_cleanup_wiki_mining_runs_deletes_only_safe_completed_runs():
    session = AsyncMock()
    old_runs = MagicMock()
    old_runs.scalars.return_value = [1, 2]
    no_pending = MagicMock()
    no_pending.scalar_one_or_none.return_value = None
    has_pending = MagicMock()
    has_pending.scalar_one_or_none.return_value = 99
    run = MagicMock()
    session.execute.side_effect = [old_runs, no_pending, no_pending, has_pending]
    session.get.return_value = run

    with patch("pkg.services.cross_cutting.retention.async_session") as session_factory:
        session_factory.return_value.__aenter__.return_value = session
        deleted = await cleanup_wiki_mining_runs(retention_days=90)

    assert deleted == 1
    session.delete.assert_awaited_once_with(run)
