from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.foundation.source import Source, SourceMedia


def _source(user_id: str) -> Source:
    return Source(
        id="source-1",
        user_id=user_id,
        category_id=1,
        title="Diagram",
        source_type="image",
        file_path="minio://bucket/source.png",
        content_hash="abc",
        ingested_at=datetime(2026, 9, 16),
    )


@pytest.mark.asyncio
async def test_get_source_media_returns_presigned_thumbnail(mock_session, fake_user):
    from pkg.api.sources import get_source_media

    source = _source(fake_user.id)
    media = SourceMedia(
        source_id=source.id,
        thumbnail_path="minio://bucket/thumb.jpg",
        processing_status="completed",
        processing_version=1,
        processing_attempts=1,
    )
    mock_session.get.side_effect = [source, media]
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://storage/thumb.jpg")

    with patch("pkg.api.sources.get_storage_service", return_value=storage):
        result = await get_source_media(source.id, user=fake_user, session=mock_session)

    assert result.thumbnail_url == "https://storage/thumb.jpg"
    assert result.processing_status == "completed"


@pytest.mark.asyncio
async def test_retry_source_media_processing_resets_attempts(mock_session, fake_user):
    from pkg.api.sources import retry_source_media_processing

    source = _source(fake_user.id)
    media = SourceMedia(
        source_id=source.id,
        processing_status="failed",
        processing_version=1,
        processing_attempts=3,
    )
    mock_session.get.return_value = source

    with (
        patch("pkg.api.sources.queue_media_processing", new=AsyncMock(return_value=media)) as queue,
        patch("pkg.api.sources._source_media_read", new=AsyncMock(return_value=MagicMock())),
    ):
        await retry_source_media_processing(source.id, user=fake_user, session=mock_session)

    queue.assert_awaited_once_with(mock_session, source, force=True)
    assert media.processing_attempts == 0
    mock_session.commit.assert_awaited_once()
