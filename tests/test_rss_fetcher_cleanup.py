from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.rss_fetcher import cleanup_old_rss_articles


class _Article:
    def __init__(self, article_id: str, *, metadata=None, file_path=None):
        self.id = article_id
        self.metadata_ = metadata or {}
        self.file_path = file_path


@pytest.mark.asyncio
async def test_cleanup_old_rss_articles_skips_reviewed_kept_articles():
    old_kept = _Article("article-kept", metadata={"feed_source_id": "feed-1", "review_status": "reviewed_kept"})
    old_unkept = _Article("article-old", metadata={"feed_source_id": "feed-1", "review_status": "imported_reviewable"})

    session = AsyncMock()
    rows = MagicMock()
    rows.scalars.return_value = [old_kept, old_unkept]
    session.execute.side_effect = [rows, MagicMock(), MagicMock()]

    storage = AsyncMock()

    with patch("pkg.services.foundation.rss_fetcher.async_session") as session_factory, patch(
        "pkg.services.foundation.rss_fetcher.get_storage_service", return_value=storage
    ):
        session_factory.return_value.__aenter__.return_value = session
        deleted = await cleanup_old_rss_articles()

    assert deleted == 1
    session.delete.assert_awaited_once_with(old_unkept)
    executed = [call.args[0] for call in session.execute.await_args_list[1:]]
    sql_texts = [str(stmt) for stmt in executed]
    assert any("DELETE FROM source_chunks" in sql for sql in sql_texts)
    assert any("DELETE FROM source_embeddings" in sql for sql in sql_texts)
