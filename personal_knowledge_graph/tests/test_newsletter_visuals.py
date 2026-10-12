from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.application.asset import Asset
from pkg.models.foundation.source import Source
from pkg.schemas.application.asset import AssetVisualBrief, AssetVisualPlanRead, AssetVisualRead, NewsletterAutomationConfig
from pkg.services.application.newsletter_automation import generate_newsletter, retry_newsletter_cover


def _visual(now: datetime, *, visual_id: str = "visual-1") -> AssetVisualRead:
    return AssetVisualRead(
        id=visual_id,
        asset_id="asset-newsletter",
        role="cover",
        status="queued",
        prompt="Create an abstract editorial cover without text or logos.",
        model="qwen-image-3.0-pro",
        processing_attempts=0,
        metadata_={"batch_id": "batch-1"},
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("cover_failure", [False, True])
@pytest.mark.parametrize(("review_mode", "candidate_count", "expected_auto_accept"), [
    ("draft_only", 2, False),
    ("auto_accept", 1, True),
])
async def test_newsletter_cover_generation_is_optional_and_non_blocking(
    cover_failure,
    review_mode,
    candidate_count,
    expected_auto_accept,
):
    now = datetime(2026, 10, 8, 8, 0, tzinfo=timezone.utc)
    config = NewsletterAutomationConfig(
        enabled=True,
        frequency="daily",
        topics=["agent"],
        max_news_items=1,
        max_paper_items=0,
        generate_cover_image=True,
        cover_review_mode=review_mode,
        cover_style_profile="minimal_abstract",
        cover_candidate_count=candidate_count,
    )
    source = Source(
        id="news-1",
        user_id="user-1",
        category_id=1,
        title="Agent platform update",
        source_type="article",
        url="https://example.com/news",
        raw_content="A recent agent platform update.",
        metadata_={"kind": "news"},
    )
    source.ingested_at = now.replace(tzinfo=None)
    source_result = MagicMock()
    source_result.scalars.return_value = [source]
    discovery_result = MagicMock()
    discovery_result.scalars.return_value = []
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[source_result, discovery_result])
    asset = Asset(
        id="asset-newsletter",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="Agent platform update",
        source_refs=["news-1"],
        note_refs=[],
        wiki_refs=[],
    )
    asset.created_at = now
    asset.updated_at = now

    visual_plan = AssetVisualPlanRead(
        style_preset="minimal_abstract",
        planner_mode="fallback",
        brief=AssetVisualBrief(
            concept="Agent infrastructure",
            composition="One focal point with editorial whitespace",
            style="Minimal abstract",
            palette=["#0B1F3A", "#F59E0B"],
            must_include=["clear focus"],
            must_avoid=["text", "logos"],
            prompt="Create an abstract editorial cover without text or logos.",
            alt_text="Abstract agent infrastructure cover.",
        ),
    )

    with patch(
        "pkg.services.application.newsletter_automation.get_newsletter_config",
        new=AsyncMock(return_value=config),
    ), patch(
        "pkg.services.application.newsletter_automation.create_asset",
        new=AsyncMock(return_value=asset),
    ), patch(
        "pkg.services.application.newsletter_automation._save_newsletter_config",
        new=AsyncMock(),
    ), patch(
        "pkg.services.application.newsletter_automation._newsletter_llm_runtime",
        return_value=None,
        create=True,
    ), patch(
        "pkg.services.application.newsletter_automation._select_newsletter_title",
        new=AsyncMock(return_value=("Agent platform update · 2026-10-08", "news-1", None, "fallback")),
        create=True,
    ), patch(
        "pkg.services.application.newsletter_automation._rewrite_newsletter_details",
        new=AsyncMock(return_value=({}, None)),
    ), patch(
        "pkg.services.application.newsletter_automation.plan_asset_visual",
        new=AsyncMock(return_value=visual_plan),
    ) as plan_mock, patch(
        "pkg.services.application.newsletter_automation.generate_asset_visual_candidates",
        new=AsyncMock(
            side_effect=RuntimeError("provider unavailable") if cover_failure else None,
            return_value=[_visual(now)],
        ),
    ) as generate_mock:
        result = await generate_newsletter(session, user_id="user-1", now=now)

    assert result.status == "generated"
    assert result.cover is not None
    assert result.cover.status == ("failed" if cover_failure else "queued")
    assert result.cover.asset_id == "asset-newsletter"
    assert bool(result.cover.plan) is (not cover_failure)
    assert len(result.cover.visuals) == (0 if cover_failure else 1)
    plan_mock.assert_awaited_once()
    generate_mock.assert_awaited_once()
    assert generate_mock.await_args.kwargs["auto_accept"] is expected_auto_accept
    assert generate_mock.await_args.kwargs["body"].candidate_count == candidate_count
    assert generate_mock.await_args.kwargs["body"].style_preset == "minimal_abstract"


@pytest.mark.asyncio
async def test_retry_newsletter_cover_reuses_saved_asset_snapshot_only():
    now = datetime(2026, 10, 8, 8, 0, tzinfo=timezone.utc)
    saved_config = NewsletterAutomationConfig(
        config_revision=4,
        enabled=True,
        frequency="daily",
        style_notes="Use a restrained saved style.",
        generate_cover_image=True,
        cover_review_mode="draft_only",
        cover_style_profile="research_brief",
        cover_candidate_count=3,
        last_asset_id="asset-newsletter",
    )
    current_config = saved_config.model_copy(update={
        "style_notes": "Unsaved current style must not be used.",
        "cover_style_profile": "minimal_abstract",
        "cover_candidate_count": 1,
    })
    snapshot_fields = {
        "config_revision", "enabled", "name", "topics", "frequency", "hour_utc", "weekday_utc",
        "lookback_days", "max_news_items", "max_paper_items", "delivery_format", "audience",
        "style_notes", "generate_cover_image", "cover_review_mode", "cover_style_profile",
        "cover_candidate_count",
    }
    asset = Asset(
        id="asset-newsletter",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="Saved Newsletter",
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        metadata_={
            "newsletter_automation": {
                "config_snapshot": saved_config.model_dump(mode="json", include=snapshot_fields),
            },
        },
    )
    asset.created_at = now
    asset.updated_at = now
    visual_plan = AssetVisualPlanRead(
        style_preset="research_brief",
        planner_mode="fallback",
        brief=AssetVisualBrief(
            concept="Saved concept",
            composition="Saved composition",
            style="Research brief",
            prompt="Generate a saved cover concept.",
            alt_text="Saved cover concept.",
        ),
    )

    with patch(
        "pkg.services.application.newsletter_automation.get_newsletter_config",
        new=AsyncMock(return_value=current_config),
    ), patch(
        "pkg.services.application.newsletter_automation.get_asset",
        new=AsyncMock(return_value=asset),
    ), patch(
        "pkg.services.application.newsletter_automation.plan_asset_visual",
        new=AsyncMock(return_value=visual_plan),
    ) as plan_mock, patch(
        "pkg.services.application.newsletter_automation.generate_asset_visual_candidates",
        new=AsyncMock(return_value=[_visual(now)]),
    ) as generate_mock, patch(
        "pkg.services.application.newsletter_automation.search_news_articles",
        new=AsyncMock(),
    ) as search_mock, patch(
        "pkg.services.application.newsletter_automation._select_newsletter_title",
        new=AsyncMock(),
    ) as title_mock, patch(
        "pkg.services.application.newsletter_automation._rewrite_newsletter_details",
        new=AsyncMock(),
    ) as rewrite_mock:
        result = await retry_newsletter_cover(AsyncMock(), user_id="user-1")

    assert result.status == "queued"
    assert len(result.visuals) == 1
    assert plan_mock.await_args.kwargs["body"].style_preset == "research_brief"
    assert plan_mock.await_args.kwargs["body"].instructions == "Use a restrained saved style."
    assert generate_mock.await_args.kwargs["body"].candidate_count == 3
    search_mock.assert_not_awaited()
    title_mock.assert_not_awaited()
    rewrite_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_retry_newsletter_cover_requires_last_asset():
    with patch(
        "pkg.services.application.newsletter_automation.get_newsletter_config",
        new=AsyncMock(return_value=NewsletterAutomationConfig()),
    ):
        with pytest.raises(Exception) as exc_info:
            await retry_newsletter_cover(AsyncMock(), user_id="user-1")

    assert getattr(exc_info.value, "status_code", None) == 409


def test_newsletter_auto_accept_requires_one_candidate():
    with pytest.raises(ValueError, match="exactly one candidate"):
        NewsletterAutomationConfig(
            generate_cover_image=True,
            cover_review_mode="auto_accept",
            cover_candidate_count=2,
        )
