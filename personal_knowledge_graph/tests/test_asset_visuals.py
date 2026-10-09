from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import httpx
from fastapi import HTTPException

from pkg.models.application.asset import Asset, AssetVisual
from pkg.schemas.application.asset import AssetVisualGenerateRequest
from pkg.services.application.asset_visuals import (
    cancel_asset_visual,
    decide_asset_visual,
    delete_asset_visual,
    generate_asset_visual,
    process_asset_visual,
)
from pkg.services.foundation.image_generation import GeneratedImage


def _asset(*, metadata: dict | None = None) -> Asset:
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="AI infrastructure update",
        brief="A practical overview of this week's platform changes.",
        draft_content="The issue compares model serving and agent infrastructure changes.",
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        metadata_=metadata,
    )
    return asset


def _visual(*, status: str = "ready", file_path: str | None = "minio://pkg/asset-visuals/cover.png") -> AssetVisual:
    now = datetime(2026, 10, 8, tzinfo=timezone.utc)
    visual = AssetVisual(
        id="visual-1",
        asset_id="asset-1",
        user_id="user-1",
        role="cover",
        status=status,
        prompt="Editorial technology cover",
        model="qwen-image-3.0-pro",
        width=1280,
        height=720,
        mime_type="image/png",
        file_path=file_path,
        metadata_={"provider": "dashscope"},
    )
    visual.created_at = now
    visual.updated_at = now
    return visual


@pytest.mark.asyncio
async def test_generate_asset_visual_queues_cover():
    asset = _asset()
    session = AsyncMock()
    session.add = MagicMock()
    session.get = AsyncMock(return_value=asset)
    active_result = MagicMock()
    active_result.scalars.return_value = []
    count_result = MagicMock()
    count_result.scalar.return_value = 0
    session.execute = AsyncMock(side_effect=[active_result, count_result])

    async def refresh(instance):
        if isinstance(instance, AssetVisual):
            now = datetime(2026, 10, 8, tzinfo=timezone.utc)
            instance.created_at = now
            instance.updated_at = now

    session.refresh = AsyncMock(side_effect=refresh)
    result = await generate_asset_visual(
        session,
        user_id="user-1",
        asset_id="asset-1",
        body=AssetVisualGenerateRequest(),
    )

    stored = session.add.call_args.args[0]
    assert stored.status == "queued"
    assert stored.processing_attempts == 0
    assert result.status == "queued"
    assert result.image_url is None
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_process_asset_visual_uploads_generated_cover():
    asset = _asset()
    visual = _visual(status="generating", file_path=None)
    visual.width = None
    visual.height = None
    visual.mime_type = None
    visual.processing_attempts = 1
    visual.metadata_ = {"size": "1280*720", "provider": "dashscope"}
    session = AsyncMock()
    session.get = AsyncMock(side_effect=[visual, asset])
    context = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))
    storage = MagicMock()
    storage.build_object_key.return_value = "asset-visuals/asset-1/cover.png"
    storage.upload_bytes = AsyncMock(return_value="minio://pkg/asset-visuals/asset-1/cover.png")
    generated = GeneratedImage(b"image-bytes", "image/png", 1280, 720, "request-1", "example.com")

    with patch("pkg.services.application.asset_visuals.async_session", return_value=context), patch(
        "pkg.services.application.asset_visuals.generate_qwen_image", new=AsyncMock(return_value=generated)
    ), patch("pkg.services.application.asset_visuals.get_storage_service", return_value=storage), patch(
        "pkg.services.application.asset_visuals.record_system_event", new=AsyncMock()
    ) as event_mock:
        await process_asset_visual("visual-1")

    assert visual.status == "ready"
    assert visual.file_path == "minio://pkg/asset-visuals/asset-1/cover.png"
    assert visual.provider_request_id == "request-1"
    session.commit.assert_awaited_once()
    event_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_asset_visual_reuses_matching_active_task():
    asset = _asset()
    existing = _visual(status="queued", file_path=None)
    existing.processing_attempts = 0
    existing.metadata_ = {"size": "1280*720", "provider": "dashscope"}
    session = AsyncMock()
    session.add = MagicMock()
    session.get = AsyncMock(return_value=asset)
    active_result = MagicMock()
    active_result.scalars.return_value = [existing]
    session.execute = AsyncMock(return_value=active_result)

    result = await generate_asset_visual(
        session,
        user_id="user-1",
        asset_id="asset-1",
        body=AssetVisualGenerateRequest(prompt="Editorial technology cover"),
    )

    assert result.id == "visual-1"
    session.add.assert_not_called()
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_process_asset_visual_schedules_retry_after_provider_failure():
    asset = _asset()
    visual = _visual(status="generating", file_path=None)
    visual.processing_attempts = 1
    visual.metadata_ = {"size": "1280*720", "provider": "dashscope"}
    session = AsyncMock()
    session.get = AsyncMock(side_effect=[visual, asset, visual])
    context = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))

    with patch("pkg.services.application.asset_visuals.async_session", return_value=context), patch(
        "pkg.services.application.asset_visuals.generate_qwen_image",
        new=AsyncMock(side_effect=RuntimeError("provider unavailable")),
    ):
        await process_asset_visual("visual-1")

    assert visual.status == "retrying"
    assert visual.next_retry_at is not None
    assert visual.error_message == "provider unavailable"
    assert visual.metadata_["error_code"] == "provider_error"
    assert visual.metadata_["error_retryable"] is True
    session.rollback.assert_awaited_once()
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_asset_visual_limits_active_tasks_per_user():
    asset = _asset()
    session = AsyncMock()
    session.get = AsyncMock(return_value=asset)
    active_result = MagicMock()
    active_result.scalars.return_value = []
    count_result = MagicMock()
    count_result.scalar.return_value = 2
    session.execute = AsyncMock(side_effect=[active_result, count_result])

    with pytest.raises(HTTPException) as exc_info:
        await generate_asset_visual(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=AssetVisualGenerateRequest(),
        )

    assert exc_info.value.status_code == 429


@pytest.mark.asyncio
async def test_process_asset_visual_fails_immediately_for_provider_auth_error():
    asset = _asset()
    visual = _visual(status="generating", file_path=None)
    visual.processing_attempts = 1
    visual.metadata_ = {"size": "1280*720", "provider": "dashscope"}
    session = AsyncMock()
    session.get = AsyncMock(side_effect=[visual, asset, visual])
    context = MagicMock(__aenter__=AsyncMock(return_value=session), __aexit__=AsyncMock(return_value=None))
    request = httpx.Request("POST", "https://dashscope.example/generate")
    response = httpx.Response(401, request=request)
    error = httpx.HTTPStatusError("unauthorized", request=request, response=response)

    with patch("pkg.services.application.asset_visuals.async_session", return_value=context), patch(
        "pkg.services.application.asset_visuals.generate_qwen_image", new=AsyncMock(side_effect=error)
    ), patch("pkg.services.application.asset_visuals.record_system_event", new=AsyncMock()) as event_mock:
        await process_asset_visual("visual-1")

    assert visual.status == "failed"
    assert visual.metadata_["error_code"] == "provider_auth"
    assert visual.metadata_["error_retryable"] is False
    event_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancel_asset_visual_marks_queued_task_cancelled():
    asset = _asset()
    visual = _visual(status="queued", file_path=None)
    visual.processing_attempts = 0
    visual.next_retry_at = datetime(2026, 10, 8, tzinfo=timezone.utc)
    session = AsyncMock()
    session.get = AsyncMock(side_effect=[asset, visual])

    result = await cancel_asset_visual(
        session,
        user_id="user-1",
        asset_id="asset-1",
        visual_id="visual-1",
    )

    assert result.status == "cancelled"
    assert visual.next_retry_at is None
    assert visual.completed_at is not None
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_accept_asset_visual_sets_cover_and_demotes_previous_acceptance():
    asset = _asset(metadata={"existing": True, "cover_visual_id": "visual-old"})
    visual = _visual()
    session = AsyncMock()
    session.get = AsyncMock(side_effect=[asset, visual])
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://minio.example/cover.png")

    with patch("pkg.services.application.asset_visuals.get_storage_service", return_value=storage):
        result = await decide_asset_visual(
            session,
            user_id="user-1",
            asset_id="asset-1",
            visual_id="visual-1",
            decision="accept",
        )

    assert result.status == "accepted"
    assert asset.metadata_ == {"existing": True, "cover_visual_id": "visual-1"}
    session.execute.assert_awaited_once()
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_reject_and_delete_visual_clear_selected_cover():
    asset = _asset(metadata={"cover_visual_id": "visual-1"})
    visual = _visual(status="accepted")
    session = AsyncMock()
    session.get = AsyncMock(side_effect=[asset, visual])
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://minio.example/cover.png")

    with patch("pkg.services.application.asset_visuals.get_storage_service", return_value=storage):
        rejected = await decide_asset_visual(
            session,
            user_id="user-1",
            asset_id="asset-1",
            visual_id="visual-1",
            decision="reject",
        )

    assert rejected.status == "rejected"
    assert asset.metadata_ is None

    asset.metadata_ = {"cover_visual_id": "visual-1"}
    session.get = AsyncMock(side_effect=[asset, visual])
    storage.delete_object = AsyncMock()
    with patch("pkg.services.application.asset_visuals.get_storage_service", return_value=storage):
        await delete_asset_visual(session, user_id="user-1", asset_id="asset-1", visual_id="visual-1")

    storage.delete_object.assert_awaited_once_with("minio://pkg/asset-visuals/cover.png")
    session.delete.assert_awaited_once_with(visual)
    assert asset.metadata_ is None
