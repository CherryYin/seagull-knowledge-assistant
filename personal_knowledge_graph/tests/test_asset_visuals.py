from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.application.asset import Asset, AssetVisual
from pkg.schemas.application.asset import AssetVisualGenerateRequest
from pkg.services.application.asset_visuals import (
    decide_asset_visual,
    delete_asset_visual,
    generate_asset_visual,
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
async def test_generate_asset_visual_uploads_generated_cover():
    asset = _asset()
    session = AsyncMock()
    session.add = MagicMock()
    session.get = AsyncMock(return_value=asset)

    async def refresh(instance):
        if isinstance(instance, AssetVisual):
            now = datetime(2026, 10, 8, tzinfo=timezone.utc)
            instance.created_at = now
            instance.updated_at = now

    session.refresh = AsyncMock(side_effect=refresh)
    storage = MagicMock()
    storage.build_object_key.return_value = "asset-visuals/asset-1/cover.png"
    storage.upload_bytes = AsyncMock(return_value="minio://pkg/asset-visuals/asset-1/cover.png")
    storage.generate_download_url = AsyncMock(return_value="https://minio.example/cover.png")
    generated = GeneratedImage(
        payload=b"image-bytes",
        content_type="image/png",
        width=1280,
        height=720,
        provider_request_id="request-1",
        source_host="dashscope-result.example",
    )

    with patch("pkg.services.application.asset_visuals.generate_qwen_image", new=AsyncMock(return_value=generated)), patch(
        "pkg.services.application.asset_visuals.get_storage_service", return_value=storage
    ):
        result = await generate_asset_visual(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=AssetVisualGenerateRequest(),
        )

    stored = session.add.call_args.args[0]
    assert stored.status == "ready"
    assert stored.file_path == "minio://pkg/asset-visuals/asset-1/cover.png"
    assert stored.provider_request_id == "request-1"
    assert stored.metadata_["source_host"] == "dashscope-result.example"
    assert result.image_url == "https://minio.example/cover.png"
    assert result.width == 1280
    assert session.commit.await_count == 2


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
