from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import markdown
import pytest

from pkg.models.application.asset import Asset
from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source
from pkg.models.user import UserSettings
from pkg.schemas.application.asset import (
    AssetVisualBrief,
    AssetVisualPlanRead,
    NewsletterAutomationConfig,
    NewsletterAutomationUpdate,
)
from pkg.schemas.connector import NewsArticle
from pkg.services.application.blog_generation import export_html, export_markdown, export_wechat_html
from pkg.services.application.newsletter_automation import (
    _rewrite_newsletter_details,
    _save_newsletter_config,
    _select_newsletter_title,
    _source_is_in_publication_window,
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
    news = Source(id="news-1", user_id="user-1", category_id=1, title="AI chip launch", source_type="article", url="https://example.com/news", raw_content="A new accelerator launched. The article describes improved memory bandwidth and power efficiency for deployment.", metadata_={"kind": "news"})
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
    assert "- [1. AI chip launch](#1-ai-chip-launch) — A new accelerator launched." in content
    assert "## In Depth" in content
    assert "### 1. [AI chip launch](https://example.com/news)" in content
    assert "[Read the original ↗](https://example.com/news)" in content
    assert "The article describes improved memory bandwidth" in content
    assert "- [2. Agent systems paper](#2-agent-systems-paper)" in content
    assert "### 3. [New robotics research](https://example.com/paper)" in content
    assert "[Source: news-1]" in content
    assert "[Source: paper-1]" in content
    assert "[Discovery: 7]" in content
    assert "explicit user review" in content

    asset = Asset(
        id="newsletter-1", user_id="user-1", asset_type="newsletter_issue", status="draft",
        title="Tech Weekly · 2026-09-03", draft_content=content, source_refs=[news.id, paper.id],
        note_refs=[], wiki_refs=[], metadata_={},
    )
    exported = export_markdown(asset)
    assert exported.count("### 1. [AI chip launch]") == 1
    html = markdown.markdown(exported, extensions=["extra", "sane_lists", "toc"])
    assert 'href="#1-ai-chip-launch"' in html
    assert 'id="1-ai-chip-launch"' in html
    assert '<a href="https://example.com/news">AI chip launch</a>' in html
    exported_html = export_html(asset)
    assert 'href="#1-ai-chip-launch"' in exported_html
    assert 'id="1-ai-chip-launch"' in exported_html
    assert '<a href="https://example.com/news">AI chip launch</a>' in exported_html
    assert 'id="1-ai-chip-launch" class="newsletter-detail-title"' in exported_html
    assert '.asset-body h3.newsletter-detail-title' in exported_html
    wechat_html = export_wechat_html(asset)
    assert 'href="#1-ai-chip-launch"' in wechat_html
    assert 'id="1-ai-chip-launch"' in wechat_html


def test_newsletter_items_with_duplicate_titles_link_to_distinct_details_and_keep_invalid_urls_local():
    news = [
        Source(id=f"news-{index}", user_id="user-1", category_id=1, title="机器人系统更新" if index == 3 else "Same headline", source_type="article",
               url="javascript:alert(1)" if index == 1 else "https://example.com/(research)" if index == 3 else f"https://example.com/{index}", raw_content="A collected report with extra detail.", metadata_={"kind": "news"})
        for index in (1, 2, 3)
    ]
    content = build_newsletter_markdown(
        title="Weekly", config=NewsletterAutomationConfig(), news_sources=news,
        paper_sources=[], paper_discoveries=[], generated_at=datetime(2026, 9, 3, tzinfo=timezone.utc),
    )
    assert "[1. Same headline](#1-same-headline)" in content
    assert "[2. Same headline](#2-same-headline)" in content
    assert "### 1. [Same headline](/sources/news-1)" in content
    assert "[Open saved source ↗](/sources/news-1)" in content
    assert "javascript:" not in content
    assert "[3. 机器人系统更新](#3-机器人系统更新)" in content
    assert "### 3. [机器人系统更新](https://example.com/%28research%29)" in content
    asset = Asset(
        id="newsletter-duplicate", user_id="user-1", asset_type="newsletter_issue", status="draft",
        title="Weekly", draft_content=content, source_refs=[item.id for item in news],
        note_refs=[], wiki_refs=[], metadata_={},
    )
    html = export_html(asset)
    assert 'id="3-机器人系统更新"' in html


def test_newsletter_detail_uses_clean_summary_instead_of_rendering_source_markdown():
    source = Source(
        id="news-markdown",
        user_id="user-1",
        category_id=1,
        title="Structured article",
        source_type="article",
        url="https://example.com/structured",
        raw_content=(
            "# Structured article\n"
            "Source: Example News\n"
            "Author: Reporter\n"
            "URL: https://example.com/structured\n\n"
            "## Summary\n"
            "A **clean**, useful summary with [supporting context](https://example.com/context).\n\n"
            "## Content\n"
            "# This heading must not leak into the newsletter detail.\n"
            "Long source body."
        ),
        metadata_={"kind": "news"},
    )

    content = build_newsletter_markdown(
        title="Weekly",
        config=NewsletterAutomationConfig(),
        news_sources=[source],
        paper_sources=[],
        paper_discoveries=[],
        generated_at=datetime(2026, 9, 28, tzinfo=timezone.utc),
    )

    assert "A clean, useful summary with supporting context." in content
    assert "This heading must not leak" not in content
    html = markdown.markdown(content, extensions=["extra", "sane_lists", "toc"])
    assert html.count("<h1") == 1


def test_newsletter_converts_traditional_chinese_content_to_simplified_chinese():
    source = Source(
        id="news-traditional",
        user_id="user-1",
        category_id=1,
        title="AI寫程式與軟體網路",
        source_type="article",
        url="https://example.com/traditional",
        raw_content="這是一則介紹人工智慧應用與網路軟體的繁體內容。",
        metadata_={"kind": "news"},
    )

    content = build_newsletter_markdown(
        title="技術週報",
        config=NewsletterAutomationConfig(topics=["人工智慧", "軟體開發"]),
        news_sources=[source],
        paper_sources=[],
        paper_discoveries=[],
        generated_at=datetime(2026, 9, 29, tzinfo=timezone.utc),
    )

    assert "# 技术周报" in content
    assert "AI写程序与软件网络" in content
    assert "人工智能, 软件开发" in content
    assert "这是一则介绍人工智能应用与网络软件的繁体内容。" in content
    assert "技術" not in content
    assert "寫程式" not in content
    assert "軟體" not in content
    assert "網路" not in content


def test_newsletter_publication_window_rejects_republished_old_news():
    cutoff = datetime(2026, 9, 24, tzinfo=timezone.utc)
    current = datetime(2026, 10, 1, tzinfo=timezone.utc)
    source = Source(
        id="news-republished-old",
        user_id="user-1",
        category_id=1,
        title="旧访谈被重新抓取",
        source_type="article",
        raw_content="本文首发于 Founder Park 公众号 · 2024 年 9 月 19 日。这里是旧文章正文。",
        metadata_={"kind": "news", "published_at": "2026-09-28T13:32:09+00:00"},
    )

    assert _source_is_in_publication_window(source, cutoff, current) is False


def test_newsletter_publication_window_accepts_recent_news_metadata():
    cutoff = datetime(2026, 9, 24, tzinfo=timezone.utc)
    current = datetime(2026, 10, 1, tzinfo=timezone.utc)
    source = Source(
        id="news-current",
        user_id="user-1",
        category_id=1,
        title="近期新闻",
        source_type="article",
        raw_content="近期发布的新闻正文。",
        metadata_={"kind": "news", "published_at": "2026-09-28T13:32:09Z"},
    )

    assert _source_is_in_publication_window(source, cutoff, current) is True


def test_newsletter_excludes_existing_pypi_sources_from_news_selection():
    source = Source(
        id="news-pypi",
        user_id="user-1",
        category_id=1,
        title="agent-package 1.2.3",
        source_type="article",
        url="https://pypi.org/project/agent-package/1.2.3/",
        raw_content="An LLM agent package release.",
        metadata_={"kind": "news", "published_at": "2026-10-01T01:00:00Z"},
    )

    from pkg.services.foundation.connectors import is_news_url_excluded

    assert is_news_url_excluded(source.url) is True


@pytest.mark.asyncio
async def test_newsletter_ai_rewrites_each_detail_from_its_own_source_content():
    source = Source(
        id="news-ai",
        user_id="user-1",
        category_id=1,
        title="代理式 AI 成本变化",
        source_type="article",
        url="https://example.com/agent-cost",
        raw_content="同一任务使用不同代理策略时，执行成本可能相差三十倍。文章分析了模型调用次数、上下文长度和工具重试带来的成本差异。",
        metadata_={"kind": "news"},
    )
    rewritten = (
        "这项变化说明，代理式 AI 的成本不能再只按单次模型调用估算。素材指出，同一任务在不同规划路径下可能产生三十倍的执行成本差异，"
        "主要变量包括模型调用次数、上下文持续增长、工具失败后的重复尝试，以及代理是否能够及时终止低价值步骤。对企业而言，关键不只是选择更便宜的模型，"
        "而是建立任务级预算、调用链观测和异常熔断机制。不过，现有材料没有提供完整样本规模，因此三十倍差异更适合作为风险信号，而不是所有场景的固定结论。"
    )
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=rewritten))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)

    with patch(
        "pkg.config.Settings.get_llm_providers",
        return_value=[MagicMock(id="test-provider")],
    ), patch(
        "pkg.services.cross_cutting.llm.create_async_client",
        return_value=(client, "test-model"),
    ):
        rewrites, model = await _rewrite_newsletter_details(
            [source],
            config=NewsletterAutomationConfig(audience="技术负责人", style_notes="强调数据和边界"),
        )

    assert model == "test-model"
    assert list(rewrites) == ["source:news-ai"]
    assert "建立任务级预算" in rewrites["source:news-ai"]
    assert "三十倍差异更适合作为风险信号" in rewrites["source:news-ai"]
    request = client.chat.completions.create.await_args.kwargs
    assert request["model"] == "test-model"
    assert "三十倍" in request["messages"][1]["content"]
    assert "技术负责人" in request["messages"][1]["content"]

    content = build_newsletter_markdown(
        title="技术周报",
        config=NewsletterAutomationConfig(),
        news_sources=[source],
        paper_sources=[],
        paper_discoveries=[],
        generated_at=datetime(2026, 9, 29, tzinfo=timezone.utc),
        detail_rewrites=rewrites,
    )
    assert rewrites["source:news-ai"] in content


@pytest.mark.asyncio
async def test_newsletter_ai_selects_hottest_news_title_from_candidates():
    sources = [
        Source(
            id="news-1",
            user_id="user-1",
            category_id=1,
            title="Routine SDK patch",
            source_type="article",
            raw_content="A small maintenance release with limited user impact.",
            metadata_={"kind": "news", "published_at": "2026-10-01T01:00:00Z"},
        ),
        Source(
            id="news-2",
            user_id="user-1",
            category_id=1,
            title="Major agent platform launch",
            source_type="article",
            raw_content="A widely used platform introduced a new agent runtime with broad ecosystem impact.",
            metadata_={"kind": "news", "published_at": "2026-10-01T02:00:00Z"},
        ),
    ]
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="<think>There are 2 candidates. Candidate 2 has broader impact.</think>2"))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)

    title, source_id, model, mode = await _select_newsletter_title(
        sources,
        config=NewsletterAutomationConfig(audience="技术负责人", topics=["AI agent"]),
        generated_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        llm_runtime=(client, "test-model"),
    )

    assert title == "Major agent platform launch · 2026-10-01"
    assert source_id == "news-2"
    assert model == "test-model"
    assert mode == "llm"
    request = client.chat.completions.create.await_args.kwargs
    assert "Routine SDK patch" in request["messages"][1]["content"]
    assert "Major agent platform launch" in request["messages"][1]["content"]


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
@pytest.mark.parametrize("cover_failure", [False, True])
async def test_generate_newsletter_creates_draft_asset_from_recent_items(cover_failure):
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
        generate_cover_image=True,
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
    visual_plan = AssetVisualPlanRead(
        style_preset="editorial_technology",
        planner_mode="fallback",
        brief=AssetVisualBrief(
            concept="Agent infrastructure",
            composition="Editorial focal point with whitespace",
            style="Editorial technology",
            palette=["#0B1F3A", "#F59E0B"],
            must_include=["clear focus"],
            must_avoid=["text", "logos"],
            prompt="Create an editorial cover without text or logos.",
            alt_text="Abstract agent infrastructure cover.",
        ),
    )

    with patch("pkg.services.application.newsletter_automation.get_newsletter_config", new=AsyncMock(return_value=config)), patch(
        "pkg.services.application.newsletter_automation.create_asset", new=AsyncMock(return_value=asset)
    ) as create_mock, patch(
        "pkg.services.application.newsletter_automation._save_newsletter_config", new=AsyncMock()
    ) as save_mock, patch(
        "pkg.services.application.newsletter_automation.plan_asset_visual",
        new=AsyncMock(return_value=visual_plan),
    ) as plan_visual_mock, patch(
        "pkg.services.application.newsletter_automation.generate_asset_visual_candidates",
        new=AsyncMock(side_effect=RuntimeError("provider unavailable") if cover_failure else None, return_value=[MagicMock(id="visual-1")]),
    ) as generate_visual_mock, patch(
        "pkg.services.application.newsletter_automation._newsletter_llm_runtime",
        return_value=(MagicMock(), "test-model"),
    ), patch(
        "pkg.services.application.newsletter_automation._select_newsletter_title",
        new=AsyncMock(return_value=("Agent platform update · 2026-09-03", "news-1", "test-model", "llm")),
    ), patch(
        "pkg.services.application.newsletter_automation._rewrite_newsletter_details",
        new=AsyncMock(return_value=({
            "source:news-1": "这是根据新闻正文生成的详细解读，涵盖核心变化、关键机制、影响和信息边界。" * 4,
            "discovery:9": "这是根据论文摘要生成的详细解读，说明研究方法、主要发现、应用价值和限制。" * 4,
        }, "test-model")),
    ):
        result = await generate_newsletter(session, user_id="user-1", now=now)

    assert result.status == "generated"
    assert result.news_count == 1
    assert result.paper_count == 1
    assert result.config_revision == 3
    assert result.config_snapshot is not None
    assert result.config_snapshot.topics == ["agent"]
    assert result.config_snapshot.generate_cover_image is True
    assert result.config_snapshot.cover_review_mode == "draft_only"
    plan_visual_mock.assert_awaited_once()
    generate_visual_mock.assert_awaited_once()
    assert generate_visual_mock.await_args.kwargs["auto_accept"] is False
    body = create_mock.await_args.kwargs["body"]
    assert body.asset_type == "newsletter_issue"
    assert body.status == "draft"
    assert body.title == "Agent platform update · 2026-09-03"
    assert body.source_refs == ["news-1"]
    assert body.metadata["delivery_format"] == "html"
    assert body.metadata["newsletter_automation"]["config_revision"] == 3
    assert body.metadata["newsletter_automation"]["config_snapshot"]["max_news_items"] == 3
    assert body.metadata["newsletter_automation"]["headline_source_id"] == "news-1"
    assert body.metadata["newsletter_automation"]["headline_selection_model"] == "test-model"
    assert body.metadata["newsletter_automation"]["headline_selection_mode"] == "llm"
    assert body.metadata["newsletter_automation"]["detail_rewrite_count"] == 2
    assert body.metadata["newsletter_automation"]["detail_rewrite_model"] == "test-model"
    assert "这是根据新闻正文生成的详细解读" in body.draft_content
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
async def test_scheduled_newsletter_collects_news_with_exact_window_when_local_news_is_empty():
    now = datetime(2026, 9, 16, 8, 0, tzinfo=timezone.utc)
    config = NewsletterAutomationConfig(
        config_revision=4,
        enabled=True,
        topics=[],
        frequency="daily",
        hour_utc=1,
        lookback_days=1,
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
        patch(
            "pkg.services.application.newsletter_automation._newsletter_llm_runtime",
            return_value=None,
        ),
        patch(
            "pkg.services.application.newsletter_automation._select_newsletter_title",
            new=AsyncMock(return_value=("AI infrastructure update · 2026-09-16", "news-1", None, "fallback")),
        ),
        patch(
            "pkg.services.application.newsletter_automation._rewrite_newsletter_details",
            new=AsyncMock(return_value=({}, None)),
        ),
    ):
        result = await generate_newsletter(session, user_id="user-1", now=now)

    assert result.status == "generated"
    assert result.news_count == 1
    assert result.paper_count == 0
    search_mock.assert_awaited_once()
    assert search_mock.await_args.kwargs["query"] == "AI, LLM, Agent, workflow"
    assert search_mock.await_args.kwargs["from_date"] == "2026-09-15T00:00:00+00:00"
    assert search_mock.await_args.kwargs["to_date"] == "2026-09-16T08:00:00+00:00"
    import_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_newsletter_retries_search_with_configured_topics_when_combined_query_is_empty():
    now = datetime(2026, 10, 1, 8, 0, tzinfo=timezone.utc)
    config = NewsletterAutomationConfig(
        enabled=True,
        topics=["AI agent", "LLM"],
        frequency="daily",
        hour_utc=1,
        lookback_days=1,
        max_news_items=1,
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
        title="New AI agent platform",
        url="https://example.com/agent-platform",
        description="A current AI agent release.",
        published_at=now,
    )
    source = Source(
        id="news-agent",
        user_id="user-1",
        category_id=1,
        title=article.title,
        source_type="article",
        url=article.url,
        raw_content=article.description,
        metadata_={"kind": "news", "published_at": now.isoformat()},
    )
    asset = Asset(
        id="asset-newsletter-topics",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="New AI agent platform · 2026-10-01",
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
            new=AsyncMock(side_effect=[[], [article], []]),
        ) as search_mock,
        patch(
            "pkg.services.application.newsletter_automation.import_news_article",
            new=AsyncMock(return_value=(source, True, "newsapi:agent")),
        ),
        patch(
            "pkg.services.application.newsletter_automation.create_asset",
            new=AsyncMock(return_value=asset),
        ),
        patch(
            "pkg.services.application.newsletter_automation._save_newsletter_config",
            new=AsyncMock(),
        ),
        patch(
            "pkg.services.application.newsletter_automation._newsletter_llm_runtime",
            return_value=None,
        ),
        patch(
            "pkg.services.application.newsletter_automation._select_newsletter_title",
            new=AsyncMock(return_value=(asset.title, source.id, None, "fallback")),
        ),
        patch(
            "pkg.services.application.newsletter_automation._rewrite_newsletter_details",
            new=AsyncMock(return_value=({}, None)),
        ),
    ):
        result = await generate_newsletter(session, user_id="user-1", now=now)

    assert result.status == "generated"
    assert [call.kwargs["query"] for call in search_mock.await_args_list] == [
        "AI agent, LLM",
        "AI agent",
        "LLM",
    ]
