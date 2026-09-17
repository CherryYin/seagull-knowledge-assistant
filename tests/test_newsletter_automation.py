from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.application.asset import Asset
from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source
from pkg.models.user import UserSettings
from pkg.schemas.application.asset import NewsletterAutomationConfig, NewsletterAutomationUpdate
from pkg.schemas.connector import NewsArticle
from pkg.services.application.newsletter_automation import (
    _save_newsletter_config,
    build_newsletter_markdown,
    generate_newsletter,
    is_newsletter_due,
    update_newsletter_config,
)


def test_newsletter_due_respects_daily_and_weekly_schedule():
    now = datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc)
    daily = NewsletterAutomationConfig(enabled=True, frequency="daily", hour_utc=7)
    weekly = NewsletterAutomationConfig(enabled=True, frequency="weekly", weekday_utc=3, hour_utc=7)

    assert is_newsletter_due(daily, now) is True
    assert is_newsletter_due(weekly, now) is True
    assert is_newsletter_due(daily.model_copy(update={"last_generated_at": now}), now) is False
    assert is_newsletter_due(daily.model_copy(update={"last_run_at": now, "last_run_status": "skipped"}), now) is False
    assert is_newsletter_due(weekly.model_copy(update={"weekday_utc": 4}), now) is False


def test_newsletter_markdown_keeps_sources_and_discoveries_traceable():
    news = Source(id="news-1", user_id="user-1", category_id=1, title="AI chip launch", source_type="article", url="https://example.com/news", raw_content="A new accelerator launched.", metadata_={"kind": "news"})
    paper = Source(id="paper-1", user_id="user-1", category_id=1, title="Agent systems paper", source_type="article", url="https://arxiv.org/abs/1", raw_content="A paper about reliable agents.", metadata_={"connector": "arxiv", "arxiv_id": "1"})
    discovery = DiscoveryItem(id=7, user_id="user-1", provider="openalex", item_key="paper-7", title="New robotics research", url="https://example.com/paper", summary="A useful robotics result.", payload={"item_type": "paper"}, status="recommended")

    content = build_newsletter_markdown(
        title="Tech Weekly · 2026-09-03",
        config=NewsletterAutomationConfig(topics=["AI", "robotics"]),
        news_sources=[news],
        paper_sources=[paper],
        paper_discoveries=[discovery],
        generated_at=datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc),
    )

    assert content.startswith("# Tech Weekly · 2026-09-03")
    assert "## Featured Items" in content
    assert "[Source: news-1]" in content
    assert "[Source: paper-1]" in content
    assert "[Discovery: 7]" in content
    assert "explicit user review" in content


@pytest.mark.asyncio
async def test_saving_newsletter_config_syncs_news_query_and_paper_profile():
    settings = UserSettings(user_id="user-1", settings={"existing": True})
    profile_result = MagicMock()
    profile_result.scalar_one_or_none.return_value = None
    session = MagicMock()
    session.get = AsyncMock(return_value=settings)
    session.execute = AsyncMock(return_value=profile_result)
    session.commit = AsyncMock()

    config = NewsletterAutomationConfig(
        enabled=True,
        name="Tech Daily",
        topics=["AI agents", "robotics"],
        max_paper_items=4,
    )
    await _save_newsletter_config(session, user_id="user-1", config=config)

    assert settings.settings["existing"] is True
    assert settings.settings["news_auto_search_query"] == '"AI agents" OR robotics'
    profile = session.add.call_args.args[0]
    assert profile.name == "Newsletter Automation Papers"
    assert profile.schedule == "daily"
    assert profile.include_terms == ["AI agents", "robotics"]
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_updating_newsletter_config_increments_revision_and_preserves_last_run():
    current = NewsletterAutomationConfig(
        config_revision=4,
        last_run_at=datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        last_run_status="skipped",
        last_run_reason="no_matching_items",
    )
    body = NewsletterAutomationUpdate(**NewsletterAutomationConfig(name="Updated Daily").model_dump(include=set(NewsletterAutomationUpdate.model_fields)))

    with patch("pkg.services.application.newsletter_automation.get_newsletter_config", new=AsyncMock(return_value=current)), patch(
        "pkg.services.application.newsletter_automation._save_newsletter_config", new=AsyncMock()
    ) as save_mock:
        updated = await update_newsletter_config(AsyncMock(), user_id="user-1", body=body)

    assert updated.config_revision == 5
    assert updated.name == "Updated Daily"
    assert updated.last_run_status == "skipped"
    assert updated.last_run_reason == "no_matching_items"
    save_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_newsletter_creates_draft_asset_from_recent_items():
    now = datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc)
    config = NewsletterAutomationConfig(
        config_revision=3,
        enabled=True,
        name="Tech Daily",
        topics=["agent"],
        frequency="daily",
        hour_utc=7,
        max_news_items=3,
        max_paper_items=3,
    )
    news = Source(id="news-1", user_id="user-1", category_id=1, title="Agent platform update", source_type="article", url="https://example.com/news", raw_content="Agent platform news.", metadata_={"kind": "news"})
    paper = DiscoveryItem(id=9, user_id="user-1", provider="openalex", item_key="paper-9", title="Agent evaluation paper", url="https://example.com/paper", summary="Agent evaluation results.", payload={"item_type": "paper"}, status="recommended")
    source_result = MagicMock()
    source_result.scalars.return_value = [news]
    discovery_result = MagicMock()
    discovery_result.scalars.return_value = [paper]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[source_result, discovery_result])
    asset = Asset(id="asset-newsletter", user_id="user-1", asset_type="newsletter_issue", status="draft", title="Tech Daily · 2026-09-03", source_refs=["news-1"], note_refs=[], wiki_refs=[])
    asset.created_at = now
    asset.updated_at = now

    with patch("pkg.services.application.newsletter_automation.get_newsletter_config", new=AsyncMock(return_value=config)), patch(
        "pkg.services.application.newsletter_automation.create_asset", new=AsyncMock(return_value=asset)
    ) as create_mock, patch(
        "pkg.services.application.newsletter_automation._save_newsletter_config", new=AsyncMock()
    ) as save_mock:
        result = await generate_newsletter(session, user_id="user-1", now=now)

    assert result.status == "generated"
    assert result.news_count == 1
    assert result.paper_count == 1
    assert result.config_revision == 3
    assert result.config_snapshot is not None
    assert result.config_snapshot.topics == ["agent"]
    body = create_mock.await_args.kwargs["body"]
    assert body.asset_type == "newsletter_issue"
    assert body.status == "draft"
    assert body.source_refs == ["news-1"]
    assert body.metadata["delivery_format"] == "html"
    assert body.metadata["newsletter_automation"]["config_revision"] == 3
    assert body.metadata["newsletter_automation"]["config_snapshot"]["max_news_items"] == 3
    source_statement = session.execute.await_args_list[0].args[0]
    discovery_statement = session.execute.await_args_list[1].args[0]
    source_datetimes = [
        value for value in source_statement.compile().params.values() if isinstance(value, datetime)
    ]
    discovery_datetimes = [
        value
        for value in discovery_statement.compile().params.values()
        if isinstance(value, datetime)
    ]
    assert source_datetimes and all(value.tzinfo is None for value in source_datetimes)
    assert discovery_datetimes and all(value.tzinfo is None for value in discovery_datetimes)
    saved_config = save_mock.await_args.kwargs["config"]
    assert saved_config.last_run_status == "generated"
    assert saved_config.last_news_count == 1
    assert saved_config.last_paper_count == 1


@pytest.mark.asyncio
async def test_forced_newsletter_collects_news_when_local_window_is_empty():
    now = datetime(2026, 9, 16, 8, 0, tzinfo=timezone.utc)
    config = NewsletterAutomationConfig(
        config_revision=4,
        enabled=True,
        topics=[],
        frequency="manual",
        lookback_days=7,
        max_news_items=2,
        max_paper_items=0,
    )
    empty_sources = MagicMock()
    empty_sources.scalars.return_value = []
    empty_discoveries = MagicMock()
    empty_discoveries.scalars.return_value = []
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[empty_sources, empty_discoveries])
    article = NewsArticle(
        provider="newsapi",
        title="AI infrastructure update",
        url="https://example.com/ai-infrastructure",
        description="A recent infrastructure update.",
        published_at=now,
    )
    source = Source(
        id="news-1",
        user_id="user-1",
        category_id=1,
        title=article.title,
        source_type="article",
        url=article.url,
        raw_content=article.description,
        metadata_={"kind": "news"},
    )
    asset = Asset(
        id="asset-newsletter",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="Technology Newsletter · 2026-09-16",
        source_refs=[source.id],
        note_refs=[],
        wiki_refs=[],
    )
    asset.created_at = now
    asset.updated_at = now

    with (
        patch(
            "pkg.services.application.newsletter_automation.get_newsletter_config",
            new=AsyncMock(return_value=config),
        ),
        patch(
            "pkg.services.application.newsletter_automation.search_news_articles",
            new=AsyncMock(return_value=[article]),
        ) as search_mock,
        patch(
            "pkg.services.application.newsletter_automation.import_news_article",
            new=AsyncMock(return_value=(source, True, "newsapi:example")),
        ) as import_mock,
        patch(
            "pkg.services.application.newsletter_automation.create_asset",
            new=AsyncMock(return_value=asset),
        ),
        patch(
            "pkg.services.application.newsletter_automation._save_newsletter_config",
            new=AsyncMock(),
        ),
    ):
        result = await generate_newsletter(session, user_id="user-1", force=True, now=now)

    assert result.status == "generated"
    assert result.news_count == 1
    assert result.paper_count == 0
    search_mock.assert_awaited_once()
    assert search_mock.await_args.kwargs["query"] == "AI, LLM, Agent, workflow"
    import_mock.assert_awaited_once()
