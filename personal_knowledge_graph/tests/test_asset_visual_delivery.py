from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.application.asset import Asset, AssetVisual
from pkg.services.application.asset_visual_delivery import (
    is_visual_in_delivery_snapshot,
    record_visual_delivery_snapshot,
    resolve_accepted_visuals,
)
from pkg.services.application.blog_generation import export_html, export_markdown, export_wechat_html


def _asset() -> Asset:
    return Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="ready_to_export",
        title="Visual delivery",
        brief="A delivery-safe visual workflow.",
        draft_content="## Details\n\nBody copy.",
        reference_notes="- Source",
        source_refs=["source-1"],
        note_refs=[],
        wiki_refs=[],
        metadata_={"accepted_visuals": {"cover": "visual-1"}},
    )


def _visual() -> AssetVisual:
    return AssetVisual(
        id="visual-1",
        asset_id="asset-1",
        user_id="user-1",
        role="cover",
        status="accepted",
        prompt="prompt",
        model="qwen-image-3.0-pro",
        width=1600,
        height=900,
        mime_type="image/png",
        file_path="minio://pkg/asset-visuals/cover.png",
        metadata_={"alt_text": "Layered editorial illustration."},
    )


@pytest.mark.asyncio
async def test_resolve_accepted_visuals_returns_signed_and_embedded_urls():
    session = AsyncMock()
    session.get = AsyncMock(return_value=_visual())
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://cdn.example/cover.png?signature=1")
    storage.get_object = AsyncMock(return_value=b"image-bytes")

    with patch("pkg.services.application.asset_visual_delivery.get_storage_service", return_value=storage):
        visuals = await resolve_accepted_visuals(session, asset=_asset(), include_data_url=True)

    cover = visuals["cover"]
    assert cover["image_url"].startswith("https://cdn.example/")
    assert cover["data_url"].startswith("data:image/png;base64,")
    assert cover["alt_text"] == "Layered editorial illustration."


@pytest.mark.asyncio
async def test_resolve_accepted_inline_visuals_deduplicates_block_mapping():
    asset = _asset()
    asset.metadata_ = {
        "accepted_visuals": {
            "inline_illustration": {
                "block-1": "visual-inline",
                "block-2": "visual-inline",
            },
        },
    }
    visual = _visual()
    visual.id = "visual-inline"
    visual.role = "inline_illustration"
    visual.metadata_ = {
        "alt_text": "Inline illustration.",
        "source_block_ids": ["block-1", "block-2"],
        "parent_visual_id": "visual-cover",
        "download_name": "visual-delivery-inline-illustration-inline.png",
    }
    session = AsyncMock()
    session.get = AsyncMock(return_value=visual)
    storage = MagicMock()
    storage.generate_download_url = AsyncMock(return_value="https://cdn.example/inline.png")

    with patch("pkg.services.application.asset_visual_delivery.get_storage_service", return_value=storage):
        visuals = await resolve_accepted_visuals(
            session,
            asset=asset,
            roles=("inline_illustration",),
        )

    assert list(visuals) == ["inline_illustration:visual-inline"]
    assert visuals["inline_illustration:visual-inline"]["source_block_ids"] == ["block-1", "block-2"]
    session.get.assert_awaited_once_with(AssetVisual, "visual-inline")


def test_record_visual_delivery_snapshot_accumulates_delivery_references():
    visual = {
        "visual_id": "visual-1",
        "role": "cover",
        "file_path": "minio://pkg/asset-visuals/cover.png",
        "alt_text": "Cover",
        "model": "qwen-image-3.0-pro",
        "width": 1600,
        "height": 900,
        "mime_type": "image/png",
    }
    first = record_visual_delivery_snapshot(
        {},
        delivery="html",
        visuals={"cover": visual},
        captured_at=datetime(2026, 10, 10, 8, 0, tzinfo=timezone.utc),
    )
    second = record_visual_delivery_snapshot(
        first,
        delivery="wechat_draft",
        visuals={"cover": visual},
        captured_at=datetime(2026, 10, 10, 9, 0, tzinfo=timezone.utc),
    )

    snapshot = second["visual_delivery_snapshot"]
    assert snapshot["latest"]["html"]["visual_ids"] == {"cover": "visual-1"}
    assert snapshot["latest"]["wechat_draft"]["visual_ids"] == {"cover": "visual-1"}
    assert snapshot["references"]["visual-1"]["deliveries"] == ["html", "wechat_draft"]
    assert is_visual_in_delivery_snapshot(second, visual_id="visual-1") is True


def test_exports_inject_accepted_cover_with_alt_text():
    asset = _asset()
    image_url = "https://cdn.example/cover.png?signature=1&part=2"
    alt_text = 'Layered "editorial" illustration.'

    markdown = export_markdown(asset, cover_image_url=image_url, cover_alt_text=alt_text)
    html = export_html(asset, cover_image_url=image_url, cover_alt_text=alt_text)
    wechat = export_wechat_html(asset, cover_image_url=image_url, cover_alt_text=alt_text)

    assert f"![{alt_text}](<{image_url}>)" in markdown
    assert 'class="asset-cover"' in html
    assert "Layered &quot;editorial&quot; illustration." in html
    assert "Layered &quot;editorial&quot; illustration." in wechat


def test_exports_inject_inline_visual_after_linked_asset_block_only():
    asset = _asset()
    asset.metadata_ = {
        "asset_document": {
            "schemaVersion": 1,
            "blocks": [
                {"id": "block-details", "markdown": "## Details", "revision": 1, "claim_refs": []},
                {"id": "block-body", "markdown": "Body copy.", "revision": 1, "claim_refs": []},
            ],
        },
    }
    inline_visual = {
        "visual_id": "visual-inline",
        "role": "inline_illustration",
        "image_url": "https://cdn.example/inline.png",
        "alt_text": "Inline system illustration.",
        "source_block_ids": ["block-body"],
    }

    markdown = export_markdown(asset, inline_visuals=[inline_visual])
    html = export_html(asset, inline_visuals=[inline_visual])
    wechat = export_wechat_html(asset, inline_visuals=[inline_visual])

    assert "Body copy.\n\n![Inline system illustration.](https://cdn.example/inline.png)" in markdown
    assert '<img alt="Inline system illustration." src="https://cdn.example/inline.png">' in html
    assert 'alt="Inline system illustration."' in wechat


def test_exports_skip_inline_visual_when_source_block_is_missing():
    asset = _asset()
    asset.metadata_ = {
        "asset_document": {
            "schemaVersion": 1,
            "blocks": [{"id": "block-body", "markdown": "Body copy.", "revision": 1, "claim_refs": []}],
        },
    }
    inline_visual = {
        "visual_id": "visual-inline",
        "role": "inline_illustration",
        "image_url": "https://cdn.example/inline.png",
        "alt_text": "Orphaned illustration.",
        "source_block_ids": ["block-deleted"],
    }

    assert "inline.png" not in export_markdown(asset, inline_visuals=[inline_visual])
