import io
from contextlib import asynccontextmanager
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image

from pkg.models.foundation.source import Source, SourceMedia
from pkg.services.foundation.media_processing import (
    MediaDerivatives,
    _image_derivatives,
    process_source_media,
    queue_media_processing,
)
from pkg.services.foundation.media_video import (
    TranscriptSegment,
    build_video_segment_windows,
)


def test_image_processing_creates_bounded_jpeg_thumbnail_and_metadata():
    image = Image.new("RGB", (1200, 800), "navy")
    payload = io.BytesIO()
    image.save(payload, format="PNG")

    derivatives = _image_derivatives(payload.getvalue())

    assert derivatives.mime_type == "image/png"
    assert derivatives.width == 1200
    assert derivatives.height == 800
    assert derivatives.duration_seconds is None
    with Image.open(io.BytesIO(derivatives.thumbnail)) as thumbnail:
        assert thumbnail.format == "JPEG"
        assert thumbnail.width <= 640
        assert thumbnail.height <= 640


def test_video_segment_windows_align_transcript_with_scene_boundaries(monkeypatch):
    monkeypatch.setattr("pkg.services.foundation.media_video.settings.MEDIA_VIDEO_SEGMENT_SECONDS", 30)
    monkeypatch.setattr("pkg.services.foundation.media_video.settings.MEDIA_VIDEO_MAX_SEGMENTS", 24)

    windows = build_video_segment_windows(
        65,
        [15_000],
        [
            TranscriptSegment(start_ms=2_000, end_ms=8_000, text="opening"),
            TranscriptSegment(start_ms=16_000, end_ms=20_000, text="demo"),
        ],
        "opening demo",
    )

    assert [(window.start_ms, window.end_ms) for window in windows] == [
        (0, 15_000),
        (15_000, 30_000),
        (30_000, 60_000),
        (60_000, 65_000),
    ]
    assert windows[0].transcript == "opening"
    assert windows[1].transcript == "demo"


@pytest.mark.asyncio
async def test_queue_media_processing_creates_pending_record():
    session = MagicMock()
    session.get = AsyncMock(return_value=None)
    source = MagicMock()
    source.id = "source-1"

    media = await queue_media_processing(session, source)

    assert isinstance(media, SourceMedia)
    assert media.source_id == "source-1"
    assert media.processing_status == "pending"
    session.add.assert_called_once_with(media)


@pytest.mark.asyncio
async def test_queue_media_processing_resets_failed_record_for_retry():
    session = MagicMock()
    media = SourceMedia(
        source_id="source-1",
        processing_status="failed",
        processing_attempts=3,
        error_message="vision provider unavailable",
    )
    session.get = AsyncMock(return_value=media)
    source = MagicMock()
    source.id = "source-1"

    queued = await queue_media_processing(session, source, force=True)

    assert queued.processing_status == "pending"
    assert queued.error_message is None
    assert queued.next_retry_at is None


@pytest.mark.asyncio
async def test_process_source_media_persists_derivatives_caption_and_index():
    session = MagicMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    source = Source(
        id="source-1",
        user_id="user-1",
        category_id=1,
        title="Diagram",
        source_type="image",
        file_path="minio://bucket/source.png",
        ingested_at=datetime(2026, 9, 16),
    )
    media = SourceMedia(
        source_id=source.id,
        processing_status="pending",
        processing_version=1,
        processing_attempts=0,
    )
    session.get = AsyncMock(side_effect=[source, media])

    @asynccontextmanager
    async def session_context():
        yield session

    storage = MagicMock()
    storage.get_object = AsyncMock(return_value=b"image-bytes")
    storage.upload_bytes = AsyncMock(return_value="minio://bucket/thumb.jpg")
    derivatives = MediaDerivatives("image/png", 11, 1200, 800, None, b"thumb")

    from unittest.mock import patch

    with (
        patch("pkg.services.foundation.media_processing.async_session", side_effect=session_context),
        patch("pkg.services.foundation.media_processing.get_storage_service", return_value=storage),
        patch(
            "pkg.services.foundation.media_processing.build_media_derivatives",
            new=AsyncMock(return_value=derivatives),
        ),
        patch(
            "pkg.services.foundation.media_processing.generate_media_description",
            new=AsyncMock(return_value=("Generated caption", "vision-model")),
        ),
        patch("pkg.api.sources.upsert_source_embeddings", new=AsyncMock(return_value=True)) as index,
    ):
        await process_source_media(source.id)

    assert media.processing_status == "completed"
    assert media.thumbnail_path == "minio://bucket/thumb.jpg"
    assert media.width == 1200
    assert media.height == 800
    assert media.caption == "Generated caption"
    index.assert_awaited_once_with(session, source, media_caption="Generated caption")


@pytest.mark.asyncio
async def test_process_video_media_runs_resumable_segment_pipeline():
    session = MagicMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    source = Source(
        id="video-1",
        user_id="user-1",
        category_id=1,
        title="Demo recording",
        source_type="video",
        file_path="minio://bucket/demo.mp4",
        ingested_at=datetime(2026, 9, 16),
    )
    media = SourceMedia(
        source_id=source.id,
        thumbnail_path="minio://bucket/thumb.jpg",
        width=1280,
        height=720,
        duration_seconds=60,
        caption="Video overview",
        transcript_status="pending",
        segment_count=0,
        processing_stage="caption",
        processing_status="pending",
        processing_version=1,
        processing_attempts=0,
    )
    session.get = AsyncMock(side_effect=[source, media])

    @asynccontextmanager
    async def session_context():
        yield session

    storage = MagicMock()
    storage.get_object = AsyncMock(return_value=b"video-bytes")

    from unittest.mock import patch

    with (
        patch("pkg.services.foundation.media_processing.async_session", side_effect=session_context),
        patch("pkg.services.foundation.media_processing.get_storage_service", return_value=storage),
        patch(
            "pkg.services.foundation.media_processing.process_video_segments",
            new=AsyncMock(),
        ) as process_segments,
        patch("pkg.api.sources.upsert_source_embeddings", new=AsyncMock(return_value=True)) as index,
    ):
        await process_source_media(source.id)

    process_segments.assert_awaited_once_with(
        session,
        source,
        media,
        b"video-bytes",
        "demo.mp4",
    )
    index.assert_awaited_once_with(session, source, media_caption="Video overview")
    assert media.processing_stage == "completed"
    assert media.processing_status == "completed"
