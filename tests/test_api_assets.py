from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.models.application.asset import Asset


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
        memory_refs=[],
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
async def test_create_recent_newsletter_route_delegates_to_service():
    from pkg.api.assets import create_recent_newsletter_route
    from pkg.schemas.application.asset import RecentNewsletterCreate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    created = _make_asset("asset-newsletter", fake_user.id)
    created.asset_type = "newsletter_issue"

    with patch("pkg.api.assets.create_recent_newsletter_asset", new=AsyncMock(return_value=created)) as mock_create:
        result = await create_recent_newsletter_route(
            RecentNewsletterCreate(title="Daily newsletter", opinion_notes="My take", window_days=2),
            user=fake_user,
            session=session,
        )

    assert result.id == "asset-newsletter"
    mock_create.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_asset_route_auto_creates_recent_newsletter_without_manual_refs():
    from pkg.api.assets import create_asset_route
    from pkg.schemas.application.asset import AssetCreate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    created = _make_asset("asset-newsletter", fake_user.id)
    created.asset_type = "newsletter_issue"

    with patch("pkg.api.assets.create_recent_newsletter_asset", new=AsyncMock(return_value=created)) as mock_create:
        result = await create_asset_route(
            AssetCreate(
                asset_type="newsletter_issue",
                title="Daily newsletter",
                opinion_notes="My take",
            ),
            user=fake_user,
            session=session,
        )

    assert result.id == "asset-newsletter"
    mock_create.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_asset_route_auto_generates_research_brief_content():
    from pkg.api.assets import create_asset_route
    from pkg.schemas.application.asset import AssetCreate

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    created = _make_asset("asset-brief", fake_user.id)
    created.asset_type = "research_brief"
    created.source_refs = ["src-1"]
    created.note_refs = ["note-1"]

    updated = _make_asset("asset-brief", fake_user.id)
    updated.asset_type = "research_brief"
    updated.outline = "# Outline"
    updated.draft_content = "# Draft"
    updated.reference_notes = "# References"

    with (
        patch("pkg.api.assets.create_asset", new=AsyncMock(return_value=created)) as mock_create,
        patch("pkg.api.assets.generate_outline", new=AsyncMock(return_value="# Outline")) as mock_outline,
        patch("pkg.api.assets.generate_draft", new=AsyncMock(return_value="# Draft")) as mock_draft,
        patch("pkg.api.assets.attach_references", new=AsyncMock(return_value="# References")) as mock_refs,
        patch("pkg.api.assets.update_asset", new=AsyncMock(return_value=updated)) as mock_update,
    ):
        result = await create_asset_route(
            AssetCreate(
                asset_type="research_brief",
                title="Daily brief",
                opinion_notes="My take",
                source_refs=["src-1"],
                note_refs=["note-1"],
            ),
            user=fake_user,
            session=session,
        )

    assert result.id == "asset-brief"
    mock_create.assert_awaited_once()
    mock_outline.assert_awaited_once()
    mock_draft.assert_awaited_once()
    mock_refs.assert_awaited_once()
    mock_update.assert_awaited_once()


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
async def test_generate_outline_route_updates_outline_when_missing():
    from pkg.api.assets import generate_outline_route
    from pkg.schemas.application.asset import GenerateOutlineRequest

    fake_user = MagicMock()
    fake_user.id = "user-1"
    session = AsyncMock()
    asset = _make_asset("asset-1", fake_user.id)
    asset.outline = None
    updated = _make_asset("asset-1", fake_user.id)
    updated.outline = "# Draft post\n\n## Positioning"

    with (
        patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=asset)),
        patch("pkg.api.assets.generate_outline", new=AsyncMock(return_value=updated.outline)) as mock_generate,
        patch("pkg.api.assets.update_asset", new=AsyncMock(return_value=updated)) as mock_update,
    ):
        result = await generate_outline_route(
            "asset-1",
            GenerateOutlineRequest(regenerate=False),
            user=fake_user,
            session=session,
        )

    assert result.outline == updated.outline
    mock_generate.assert_awaited_once()
    mock_update.assert_awaited_once()


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
