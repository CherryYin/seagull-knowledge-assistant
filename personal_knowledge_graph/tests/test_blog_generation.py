from datetime import datetime, timezone

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.services.application.blog_generation import GenerationContext, export_wechat_html, render_generation_context


def test_render_generation_context_groups_raw_stable_and_candidate_wiki():
    now = datetime(2026, 6, 8, tzinfo=timezone.utc)
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Blog",
        brief="brief",
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=["wiki-stable", "wiki-draft"],
        metadata_={"opinion_notes": "take", "style_notes": "clear"},
    )
    source = Source(
        id="src-1",
        user_id="user-1",
        is_shared=False,
        category_id=1,
        title="Source 1",
        source_type="web",
        url=None,
        content_hash=None,
        raw_content="raw",
        file_path=None,
        ingested_at=now,
        metadata_={},
    )
    note = Note(
        id="note-1",
        user_id="user-1",
        category_id=1,
        title="Note 1",
        note_type="inbox",
        domains=[],
        tags=[],
        abstract="abstract",
        content="content",
        project=None,
        status="seed",
        confidence="medium",
        source_ids=[],
        file_path=None,
        word_count=None,
        expires_at=None,
        kept_at=None,
        created_at=now,
        updated_at=now,
    )
    stable_wiki = WikiPage(
        id="wiki-stable",
        user_id="user-1",
        title="Stable Wiki",
        page_type="topic",
        summary="summary",
        content="content",
        domains=[],
        tags=["wiki-stable"],
        derived_from_notes=[],
        derived_from_sources=[],
        open_questions=[],
        confidence_score=0.8,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=now,
        created_at=now,
        updated_at=now,
    )
    draft_wiki = WikiPage(
        id="wiki-draft",
        user_id="user-1",
        title="Draft Wiki",
        page_type="topic",
        summary="summary",
        content="content",
        domains=[],
        tags=["wiki-draft"],
        derived_from_notes=[],
        derived_from_sources=[],
        open_questions=[],
        confidence_score=0.8,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=now,
        created_at=now,
        updated_at=now,
    )

    context = GenerationContext(
        asset=asset,
        sources=[source],
        notes=[note],
        stable_wiki_pages=[stable_wiki],
        candidate_wiki_pages=[draft_wiki],
    )

    rendered = render_generation_context(context)

    assert "# Raw Evidence" in rendered
    assert "# Stable Wiki Context" in rendered
    assert "# Candidate Wiki Context" in rendered
    assert "## Editorial Brief" in rendered
    assert "## Author Point of View" in rendered


def test_export_wechat_html_matches_reader_body_without_outline_or_evidence():
    now = datetime(2026, 9, 22, tzinfo=timezone.utc)
    asset = Asset(
        id="asset-wechat-reader",
        user_id="user-1",
        asset_type="blog_post",
        status="ready_to_export",
        title="Reader-aligned WeChat",
        brief="Digest belongs outside the article body",
        outline="Internal working outline",
        draft_content=(
            "## Main\n\nVisible body [Source: src-1]\n\n"
            "## Evidence Notes\n\nInternal evidence commentary\n\n"
            "## Review Notes\n\nInternal review commentary"
        ),
        reference_notes="Internal reference appendix",
        source_refs=["src-1"],
        note_refs=[],
        wiki_refs=[],
        metadata_={},
        created_at=now,
        updated_at=now,
    )

    rendered = export_wechat_html(asset)

    assert "Visible body" in rendered
    assert "Internal working outline" not in rendered
    assert "Internal evidence commentary" not in rendered
    assert "Internal review commentary" not in rendered
    assert "Internal reference appendix" not in rendered
    assert "Digest belongs outside the article body" not in rendered
    assert "[Source: src-1]" not in rendered


def test_wechat_newsletter_links_become_deduplicated_copyable_references():
    content = (
        "## 目录\n\n- [1. 新闻](#1-新闻)\n\n"
        '### 1. [新闻](https://example.com/news?a=1&b=2 "原文")\n\n'
        "[Read the original ↗](https://example.com/news?a=1&b=2)\n\n"
        "[论文](https://example.com/paper)\n\n"
        "[站内素材](/sources/private-source)\n\n"
        "[无效地址](javascript:alert)\n\n"
        "![配图](https://example.com/image.png)"
    )
    asset = Asset(
        id="newsletter-links", user_id="user-1", asset_type="newsletter_issue",
        title="Newsletter", draft_content=content, metadata_={},
    )

    rendered = export_wechat_html(asset)

    assert "<a " not in rendered
    assert "1. 新闻</li>" in rendered
    assert "新闻<sup> [1]</sup>" in rendered
    assert "原文参考<sup> [1]</sup>" in rendered
    assert "Read the original ↗" not in rendered
    assert "论文<sup> [2]</sup>" in rendered
    assert rendered.count("https://example.com/news?a=1&amp;b=2") == 1
    assert "[2] <span" in rendered
    assert "请长按复制网址" in rendered
    assert "原文网址（复制到浏览器打开）" in rendered
    assert "阅读提示：目录仅作内容概览" in rendered
    assert "不是可点击的跳转按钮" in rendered
    assert "/sources/private-source" not in rendered
    assert "javascript:" not in rendered
    assert 'src="https://example.com/image.png"' in rendered
    assert asset.draft_content == content


def test_wechat_newsletter_without_external_links_has_no_empty_reference_section():
    asset = Asset(
        id="newsletter-no-links", user_id="user-1", asset_type="newsletter_issue",
        title="Newsletter", draft_content="- [概览](#概览)\n\n## 概览\n\n正文", metadata_={},
    )

    rendered = export_wechat_html(asset)

    assert "<a " not in rendered
    assert "概览</li>" in rendered
    assert "原文网址（复制到浏览器打开）" not in rendered
    assert "目录仅作内容概览，不支持点击跳转" in rendered
    assert "完整网址见文末" not in rendered


def test_wechat_newsletter_uses_tech_colors_without_changing_other_exports():
    from pkg.services.application.blog_generation import export_html, export_wechat_preview_html

    asset = Asset(
        id="newsletter-tech", user_id="user-1", asset_type="newsletter_issue", status="draft",
        title="Tech newsletter", draft_content="# Tech newsletter\n\n## In Depth\n\n正文", metadata_={},
    )

    rendered = export_wechat_html(asset)
    preview = export_wechat_preview_html(asset)

    assert "TECH BRIEF / 科技简报" in rendered
    assert "background:#0b213a" in rendered
    assert "color:#67e8f9" in rendered
    assert "color:#0369a1" in rendered
    assert "background:#edf7fc" in rendered
    assert "#a21caf" not in rendered
    assert "#fae8ff" not in rendered
    assert rendered in preview
    ordinary_html = export_html(asset)
    assert "--accent:#c026d3" in ordinary_html
    assert "TECH BRIEF / 科技简报" not in ordinary_html
    asset.asset_type = "blog_post"
    blog_html = export_wechat_html(asset)
    assert "#8b5e3c" in blog_html
    assert "TECH BRIEF / 科技简报" not in blog_html


def test_wechat_newsletter_source_button_does_not_imply_public_navigation():
    asset = Asset(
        id="newsletter-local", user_id="user-1", asset_type="newsletter_issue",
        title="Local newsletter", draft_content="[Open saved source ↗](/sources/private-source)", metadata_={},
    )

    rendered = export_wechat_html(asset)

    assert "已保存素材（仅站内可访问）" in rendered
    assert "Open saved source ↗" not in rendered
    assert "/sources/private-source" not in rendered
    assert "原文网址（复制到浏览器打开）" not in rendered
