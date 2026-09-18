from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.models.application.asset import Asset


def test_asset_api_models_exclude_memory_refs():
    from pkg.schemas.application.asset import AssetCreate, AssetRead, AssetUpdate

    assert "memory_refs" not in AssetCreate.model_fields
    assert "memory_refs" not in AssetUpdate.model_fields
    assert "memory_refs" not in AssetRead.model_fields


def _make_asset(asset_id: str, user_id: str):
    asset = Asset(
        id=asset_id,
        user_id=user_id,
        asset_type="blog_post",
        status="draft",
        title="Draft post",
        brief="Write about architecture",
        source_refs=["src-1"],
        note_refs=[],
        wiki_refs=[],
    )
    asset.created_at = datetime(2026, 6, 8, tzinfo=timezone.utc)
    asset.updated_at = datetime(2026, 6, 8, tzinfo=timezone.utc)
    return asset


@pytest.mark.asyncio
async def test_create_asset_route_delegates_to_service():
    from pkg.api.assets import create_asset_route
    from pkg.schemas.application.asset import AssetCreate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    created = _make_asset("asset-1", fake_user.id)

    with patch("pkg.api.assets.create_asset", new=AsyncMock(return_value=created)) as mock_create:
        result = await create_asset_route(
            AssetCreate(title="Draft post", brief="Write about architecture", source_refs=["src-1"]),
            user=fake_user,
            session=session,
        )

    assert result.id == "asset-1"
    mock_create.assert_awaited_once()


@pytest.mark.asyncio
async def test_list_assets_route_returns_items_and_total():
    from pkg.api.assets import list_assets_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    items = [_make_asset("asset-1", fake_user.id)]

    with patch("pkg.api.assets.list_assets", new=AsyncMock(return_value=(items, 1))) as mock_list:
        result = await list_assets_route(user=fake_user, session=session)

    assert result.total == 1
    assert result.items[0].id == "asset-1"
    mock_list.assert_awaited_once()


@pytest.mark.asyncio
async def test_asset_knowledge_lineage_route_delegates_to_service():
    from pkg.api.assets import get_asset_knowledge_lineage_route
    from pkg.schemas.application.asset import AssetKnowledgeLineageList

    fake_user = MagicMock(id="user-1")
    session = AsyncMock()
    lineage = AssetKnowledgeLineageList(target_type="wiki", target_id="wiki-1", items=[])

    with patch("pkg.api.assets.list_asset_knowledge_lineage", new=AsyncMock(return_value=lineage)) as mock_list:
        result = await get_asset_knowledge_lineage_route(
            target_type="wiki",
            target_id="wiki-1",
            user=fake_user,
            session=session,
        )

    assert result.target_id == "wiki-1"
    mock_list.assert_awaited_once_with(
        session,
        user_id="user-1",
        target_type="wiki",
        target_id="wiki-1",
    )


@pytest.mark.asyncio
async def test_newsletter_automation_routes_delegate_to_services():
    from pkg.api.assets import (
        get_newsletter_automation_route,
        run_newsletter_automation_route,
        update_newsletter_automation_route,
    )
    from pkg.schemas.application.asset import (
        NewsletterAutomationConfig,
        NewsletterAutomationRunResult,
        NewsletterAutomationUpdate,
    )

    fake_user = MagicMock(id="user-1")
    session = AsyncMock()
    config = NewsletterAutomationConfig(enabled=True, frequency="daily")
    body = NewsletterAutomationUpdate(**config.model_dump(include=set(NewsletterAutomationUpdate.model_fields)))

    with patch("pkg.api.assets.get_newsletter_config", new=AsyncMock(return_value=config)) as get_mock:
        result = await get_newsletter_automation_route(user=fake_user, session=session)
    assert result.enabled is True
    get_mock.assert_awaited_once_with(session, user_id="user-1")

    with patch("pkg.api.assets.update_newsletter_config", new=AsyncMock(return_value=config)) as update_mock:
        result = await update_newsletter_automation_route(body, user=fake_user, session=session)
    assert result.frequency == "daily"
    update_mock.assert_awaited_once_with(session, user_id="user-1", body=body)

    run_result = NewsletterAutomationRunResult(status="skipped", reason="no_matching_items")
    with patch("pkg.api.assets.generate_newsletter", new=AsyncMock(return_value=run_result)) as run_mock:
        result = await run_newsletter_automation_route(user=fake_user, session=session)
    assert result.reason == "no_matching_items"
    run_mock.assert_awaited_once_with(session, user_id="user-1", force=True)


@pytest.mark.asyncio
async def test_check_readiness_route_returns_service_result():
    from pkg.api.assets import check_readiness_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.check_readiness", return_value=(False, ["Missing draft content"], ["Draft is very short"], ["Attach references first"])),
    ):
        result = await check_readiness_route("asset-1", user=fake_user, session=session)

    assert result.ready is False
    assert result.blocking_reasons == ["Missing draft content"]
    assert result.warning_reasons == ["Draft is very short"]
    assert result.suggestion_reasons == ["Attach references first"]


@pytest.mark.asyncio
async def test_update_asset_route_accepts_title_and_editor_fields():
    from pkg.api.assets import update_asset_route
    from pkg.schemas.application.asset import AssetUpdate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    updated = _make_asset("asset-1", fake_user.id)
    updated.title = "Updated title"
    updated.editor_feedback = "Tighten the intro"

    with patch("pkg.api.assets.update_asset", new=AsyncMock(return_value=updated)) as mock_update:
        result = await update_asset_route(
            "asset-1",
            AssetUpdate(title="Updated title", editor_feedback="Tighten the intro"),
            user=fake_user,
            session=session,
        )

    assert result.title == "Updated title"
    mock_update.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_asset_route_delegates_to_service():
    from pkg.api.assets import delete_asset_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()

    with patch("pkg.api.assets.delete_asset", new=AsyncMock()) as mock_delete:
        result = await delete_asset_route("asset-1", user=fake_user, session=session)

    assert result is None
    mock_delete.assert_awaited_once_with(session, user_id="user-1", asset_id="asset-1")


@pytest.mark.asyncio
async def test_delete_asset_service_deletes_owned_asset():
    from pkg.services.application.assets import delete_asset

    session = AsyncMock()
    asset = _make_asset("asset-1", "user-1")
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = asset
    session.execute.return_value = mock_result

    await delete_asset(session, user_id="user-1", asset_id="asset-1")

    session.delete.assert_awaited_once_with(asset)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_export_markdown_route_marks_asset_exported():
    from pkg.api.assets import export_markdown_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)
    asset.outline = "# Outline"
    asset.draft_content = "# Draft post\n\ncontent"
    asset.reference_notes = "## References\n\n- Source: src-1"

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.export_markdown", return_value="# Draft post\n\ncontent"),
        patch("pkg.api.assets.update_asset", new=AsyncMock(return_value=asset)) as mock_update,
    ):
        result = await export_markdown_route("asset-1", user=fake_user, session=session)

    assert result.asset_id == "asset-1"
    assert result.export_format == "markdown"
    assert "# Draft post" in result.content
    mock_update.assert_awaited_once()


@pytest.mark.asyncio
async def test_export_markdown_route_blocks_when_missing_references_section():
    from pkg.api.assets import export_markdown_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)
    asset.outline = "outline"
    asset.draft_content = "draft content"
    asset.reference_notes = None

    with patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)):
        with pytest.raises(HTTPException) as exc:
            await export_markdown_route("asset-1", user=fake_user, session=session)

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_preview_html_route_does_not_change_asset_status():
    from pkg.api.assets import preview_html_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.export_html", return_value="<!doctype html><p>Preview</p>"),
        patch("pkg.api.assets.update_asset", new=AsyncMock()) as mock_update,
    ):
        result = await preview_html_route("asset-1", user=fake_user, session=session)

    assert result.export_format == "html"
    assert "Preview" in result.content
    mock_update.assert_not_awaited()


@pytest.mark.asyncio
async def test_export_html_route_marks_asset_exported_as_html():
    from pkg.api.assets import export_html_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)
    asset.reference_notes = "- Source: src-1"

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.check_readiness", return_value=(True, [], [], [])),
        patch("pkg.api.assets.export_html", return_value="<!doctype html><p>Export</p>"),
        patch("pkg.api.assets.update_asset", new=AsyncMock(return_value=asset)) as mock_update,
    ):
        result = await export_html_route("asset-1", user=fake_user, session=session)

    assert result.export_format == "html"
    assert "Export" in result.content
    update_body = mock_update.await_args.kwargs["body"]
    assert update_body.status == "exported"
    assert update_body.export_format == "html"


@pytest.mark.asyncio
async def test_update_publish_feedback_route_blocks_research_brief_without_references():
    from pkg.api.assets import update_publish_feedback_route
    from pkg.schemas.application.asset import AssetPublishFeedbackUpdate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)
    asset.asset_type = "research_brief"
    asset.brief = "Decision memo"
    asset.outline = "## Executive Summary"
    asset.draft_content = "## Executive Summary\n\nSomething\n\n## Findings\n\nSomething\n\n## Risks\n\nSomething\n\n## Recommendations\n\nSomething"
    asset.reference_notes = None
    asset.source_refs = ["src-1"]
    asset.wiki_refs = ["wiki-1"]

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
    ):
        with pytest.raises(HTTPException) as exc:
            await update_publish_feedback_route(
                "asset-1",
                AssetPublishFeedbackUpdate(publish_url="https://example.com", channel="brief", published_at=datetime.now(timezone.utc), feedback="Ship it"),
                user=fake_user,
                session=session,
            )

    assert exc.value.status_code == 409
    assert "not ready to publish" in exc.value.detail


@pytest.mark.asyncio
async def test_update_publish_feedback_route_updates_asset():
    from pkg.api.assets import update_publish_feedback_route
    from pkg.schemas.application.asset import AssetPublishFeedbackUpdate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.update_asset", new=AsyncMock(return_value=asset)) as mock_update,
    ):
        await update_publish_feedback_route(
            "asset-1",
            AssetPublishFeedbackUpdate(publish_url="https://example.com", channel="blog", feedback="Good response"),
            user=fake_user,
            session=session,
        )

    mock_update.assert_awaited_once()


@pytest.mark.asyncio
async def test_convert_asset_feedback_to_note_route_returns_note_result():
    from pkg.api.assets import convert_asset_feedback_to_note_route

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)
    asset.editor_feedback = "Tighten opening"
    note = MagicMock()
    note.id = "note-1"

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.persist_note", new=AsyncMock(return_value=note)) as mock_persist,
    ):
        result = await convert_asset_feedback_to_note_route("asset-1", user=fake_user, session=session)

    assert result.note_id == "note-1"
    mock_persist.assert_awaited_once()
