from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.application.asset import Asset
from pkg.models.foundation.source import Source
from pkg.schemas.application.asset import NewsletterAutomationConfig
from pkg.services.application.newsletter_automation import generate_newsletter


@pytest.mark.asyncio
@pytest.mark.parametrize("cover_failure", [False, True])
async def test_newsletter_cover_generation_is_optional_and_non_blocking(cover_failure):
    now = datetime(2026, 10, 8, 8, 0, tzinfo=timezone.utc)
    config = NewsletterAutomationConfig(
        enabled=True,
        frequency="daily",
        topics=["agent"],
        max_news_items=1,
        max_paper_items=0,
        generate_cover_image=True,
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
        "pkg.services.application.newsletter_automation.generate_asset_visual",
        new=AsyncMock(
            side_effect=RuntimeError("provider unavailable") if cover_failure else None,
            return_value=MagicMock(id="visual-1"),
        ),
    ) as generate_mock:
        result = await generate_newsletter(session, user_id="user-1", now=now)

    assert result.status == "generated"
    generate_mock.assert_awaited_once()
    assert generate_mock.await_args.kwargs["auto_accept"] is True
