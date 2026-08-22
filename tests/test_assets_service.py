from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from pkg.models.application.asset import Asset
from pkg.models.foundation.source import Source
from pkg.schemas.application.asset import AssetCreate, AssetProvenance, AssetUpdate, RecentNewsletterCreate
from pkg.services.application.assets import create_asset, create_recent_newsletter_asset, update_asset


class _ScalarResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_create_asset_persists_asset_when_refs_exist():
    session = AsyncMock()
    session.add = MagicMock()
    wiki = MagicMock()
    wiki.id = "wiki-1"
    wiki.title = "Wiki One"
    wiki.metadata_ = {"claims": [{"text": "claim", "status": "supported"}]}
    wiki_result = MagicMock()
    wiki_result.scalars.return_value = iter([wiki])
    session.execute.side_effect = [
        _ScalarResult(["src-1"]),
        _ScalarResult(["note-1"]),
        _ScalarResult(["wiki-1"]),
        wiki_result,
    ]
    refreshed = {}

    async def _refresh(asset):
        refreshed["asset"] = asset

    session.refresh.side_effect = _refresh

    with pytest.MonkeyPatch.context() as m:
        async def _fake_record(*args, **kwargs):
            return None
        m.setattr("pkg.services.application.assets.record_asset_production_event", _fake_record)
        asset = await create_asset(
            session,
            user_id="user-1",
            body=AssetCreate(
                title="Draft post",
                draft_content="# Draft",
                source_refs=["src-1"],
                note_refs=["note-1"],
                wiki_refs=["wiki-1"],
                opinion_notes="Take a strong stance",
                style_notes="Write analytically",
                provenance=AssetProvenance(
                    origin_type="harness_session",
                    origin_ref="session-1",
                    action="save",
                ),
            ),
        )

    assert asset.title == "Draft post"
    assert asset.asset_type == "blog_post"
    assert asset.status == "draft"
    assert asset.draft_content == "# Draft"
    assert asset.metadata_["opinion_notes"] == "Take a strong stance"
    assert asset.metadata_["style_notes"] == "Write analytically"
    assert asset.metadata_["provenance"] == {
        "origin_type": "harness_session",
        "origin_ref": "session-1",
        "action": "save",
    }
    assert asset.metadata_["wiki_claims"][0]["wiki_title"] == "Wiki One"
    session.add.assert_called_once()
    session.commit.assert_awaited_once()
    assert refreshed["asset"] is asset


@pytest.mark.asyncio
async def test_create_asset_raises_when_source_ref_missing():
    session = AsyncMock()
    session.add = MagicMock()
    session.execute.side_effect = [
        _ScalarResult([]),
    ]

    with pytest.raises(HTTPException) as exc:
        await create_asset(
            session,
            user_id="user-1",
            body=AssetCreate(title="Draft post", source_refs=["missing-src"]),
        )

    assert exc.value.status_code == 404
    assert "Unknown source refs" in exc.value.detail


@pytest.mark.asyncio
async def test_create_recent_newsletter_asset_uses_recent_sources(monkeypatch):
    session = AsyncMock()
    session.add = MagicMock()
    source = Source(
        id="src-recent-1",
        user_id="user-1",
        is_shared=False,
        category_id=1,
        title="Recent source",
        source_type="web",
        url="https://example.com/recent",
        content_hash=None,
        raw_content="Recent article content",
        file_path=None,
        metadata_={},
    )
    source_rows = MagicMock()
    source_rows.scalars.return_value = [source]
    session.execute.side_effect = [source_rows, _ScalarResult(["src-recent-1"])]

    async def _fake_record(*args, **kwargs):
        return None

    async def _fake_outline(*args, **kwargs):
        return "# Recent source newsletter\n\n## Issue Overview"

    async def _fake_draft(*args, **kwargs):
        return "# Recent source newsletter\n\n## Featured Items\n\n- Recent source"

    async def _fake_references(*args, **kwargs):
        return "## Source References\n- Source: Recent source (src-recent-1)"

    monkeypatch.setattr("pkg.services.application.assets.record_asset_production_event", _fake_record)
    monkeypatch.setattr("pkg.services.application.assets.generate_outline", _fake_outline)
    monkeypatch.setattr("pkg.services.application.assets.generate_draft", _fake_draft)
    monkeypatch.setattr("pkg.services.application.assets.attach_references", _fake_references)

    asset = await create_recent_newsletter_asset(
        session,
        user_id="user-1",
        body=RecentNewsletterCreate(
            title="Recent source newsletter",
            opinion_notes="My editorial take",
            style_notes="Concise and sharp",
            window_days=2,
            max_sources=10,
        ),
    )

    assert asset.asset_type == "newsletter_issue"
    assert asset.source_refs == ["src-recent-1"]
    assert asset.note_refs == []
    assert asset.outline.startswith("# Recent source newsletter")
    assert "Featured Items" in asset.draft_content
    assert "Source References" in asset.reference_notes
    assert asset.metadata_["opinion_notes"] == "My editorial take"
    assert asset.metadata_["auto_source_window"]["window_days"] == 2
    session.add.assert_called_once()
    assert session.commit.await_count == 2


@pytest.mark.asyncio
async def test_create_recent_newsletter_asset_raises_without_recent_sources():
    session = AsyncMock()
    source_rows = MagicMock()
    source_rows.scalars.return_value = []
    session.execute.return_value = source_rows

    with pytest.raises(HTTPException) as exc:
        await create_recent_newsletter_asset(
            session,
            user_id="user-1",
            body=RecentNewsletterCreate(title="Recent source newsletter", opinion_notes="My take"),
        )

    assert exc.value.status_code == 404
    assert "No sources ingested" in exc.value.detail


@pytest.mark.asyncio
async def test_update_asset_persists_opinion_and_style_notes():
    session = AsyncMock()
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft post",
        brief="brief",
        outline=None,
        draft_content=None,
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = asset
    session.execute.side_effect = [scalar_result]

    updated = await update_asset(
        session,
        user_id="user-1",
        asset_id="asset-1",
        body=AssetUpdate(opinion_notes="Take a stance", style_notes="Write crisply"),
    )

    assert updated.metadata_["opinion_notes"] == "Take a stance"
    assert updated.metadata_["style_notes"] == "Write crisply"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_asset_blocks_ready_to_export_when_not_ready():
    session = AsyncMock()
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft post",
        brief=None,
        outline=None,
        draft_content=None,
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = asset
    session.execute.side_effect = [scalar_result]

    with pytest.raises(HTTPException) as exc:
        await update_asset(
            session,
            user_id="user-1",
            asset_id="asset-1",
            body=AssetUpdate(status="ready_to_export"),
        )

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_update_asset_records_publish_feedback_in_production_memory_detail(monkeypatch):
    session = AsyncMock()
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="exported",
        title="Draft post",
        brief=None,
        outline=None,
        draft_content=None,
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format="markdown",
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = asset
    session.execute.side_effect = [scalar_result]

    recorded: dict = {}

    async def _fake_record(session_arg, *, user_id, asset, event_type, detail=None):
        recorded.update({
            "user_id": user_id,
            "event_type": event_type,
            "detail": detail or {},
        })
        return MagicMock()

    monkeypatch.setattr("pkg.services.application.assets.record_asset_production_event", _fake_record)

    updated = await update_asset(
        session,
        user_id="user-1",
        asset_id="asset-1",
        body=AssetUpdate(
            status="published",
            metadata={
                "publish_feedback": {
                    "channel": "newsletter",
                    "publish_url": "https://example.com/post",
                    "feedback": "Good open rate",
                    "published_at": "2026-06-10T10:00:00Z",
                }
            },
        ),
    )

    assert updated.status == "published"
    assert recorded["event_type"] == "asset_published"
    assert recorded["detail"]["channel"] == "newsletter"
    assert recorded["detail"]["publish_url"] == "https://example.com/post"
    assert recorded["detail"]["feedback"] == "Good open rate"


@pytest.mark.asyncio
async def test_update_asset_records_editor_feedback_in_production_memory_detail(monkeypatch):
    session = AsyncMock()
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft post",
        brief=None,
        outline=None,
        draft_content=None,
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = asset
    session.execute.side_effect = [scalar_result]

    recorded: dict = {}

    async def _fake_record(session_arg, *, user_id, asset, event_type, detail=None):
        recorded.update({
            "event_type": event_type,
            "detail": detail or {},
        })
        return MagicMock()

    monkeypatch.setattr("pkg.services.application.assets.record_asset_production_event", _fake_record)

    await update_asset(
        session,
        user_id="user-1",
        asset_id="asset-1",
        body=AssetUpdate(editor_feedback="Needs a sharper conclusion"),
    )

    assert recorded["event_type"] == "asset_feedback_recorded"
    assert recorded["detail"]["feedback"] == "Needs a sharper conclusion"


def test_check_readiness_warns_for_unsupported_claims():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft post",
        brief="brief",
        outline="outline",
        draft_content="This system is the definitive solution for knowledge work and it means every team will improve output quality significantly. It shows that all prior workflows are obsolete.",
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    ready, blocking, warnings, suggestions = check_readiness(asset)

    assert ready is False
    assert any("unsupported claims" in item for item in warnings + suggestions)


def test_check_readiness_requires_wiki_and_evidence_for_research_brief():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-brief-1",
        user_id="user-1",
        asset_type="research_brief",
        status="draft",
        title="Brief",
        brief="Decision memo",
        outline="## Executive Summary",
        draft_content="## Executive Summary\n\nSomething\n\n## Findings\n\nSomething",
        reference_notes="## References\n\n- Ref",
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    ready, blocking, _warnings, suggestions = check_readiness(asset)

    assert ready is False
    assert "Research brief requires at least one wiki reference" in blocking
    assert "Research brief requires at least one source or note reference" in blocking
    assert "Research brief requires evidence references before export" not in blocking
    assert any("recommendations" in item for item in suggestions)


@pytest.mark.asyncio
async def test_update_asset_blocks_research_brief_ready_to_export_without_reference_notes():
    session = AsyncMock()
    asset = Asset(
        id="asset-brief-1",
        user_id="user-1",
        asset_type="research_brief",
        status="draft",
        title="Brief",
        brief="Decision memo",
        outline="## Executive Summary",
        draft_content="## Executive Summary\n\nSomething\n\n## Findings\n\nSomething\n\n## Risks\n\nSomething\n\n## Recommendations\n\nSomething",
        reference_notes=None,
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=[],
        wiki_refs=["wiki-1"],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = asset
    wiki_result = MagicMock()
    wiki_result.scalars.return_value = iter([])
    session.execute.side_effect = [scalar_result, _ScalarResult(["src-1"]), _ScalarResult(["wiki-1"]), wiki_result]

    with pytest.raises(HTTPException) as exc:
        await update_asset(
            session,
            user_id="user-1",
            asset_id="asset-brief-1",
            body=AssetUpdate(status="ready_to_export"),
        )

    assert exc.value.status_code == 409
    assert "evidence references" in exc.value.detail


def test_check_readiness_warns_for_weak_wiki_claims():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft post",
        brief="brief",
        outline="outline",
        draft_content="draft content with references",
        reference_notes="## References\n\n- Ref",
        editor_feedback="tighten claims",
        source_refs=["src-1"],
        note_refs=[],
        wiki_refs=["wiki-1"],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={
            "wiki_claims": [
                {"text": "claim 1", "status": "weak"},
                {"text": "claim 2", "status": "weak"},
                {"text": "claim 3", "status": "weak"},
            ]
        },
    )

    ready, _blocking, warnings, _suggestions = check_readiness(asset)

    assert ready is True
    assert any("weak claims" in item for item in warnings)


def test_export_markdown_uses_research_brief_template():
    from pkg.services.application.blog_generation import export_markdown

    asset = Asset(
        id="asset-brief-1",
        user_id="user-1",
        asset_type="research_brief",
        status="ready_to_export",
        title="AI Tooling Brief",
        brief="Assess trade-offs and recommend a default stack.",
        outline="# AI Tooling Brief\n\n## Executive Summary\n\n- Summary\n\n## Recommendations\n\n- Pick one",
        draft_content="# AI Tooling Brief\n\n## Executive Summary\n\nUse MiniMax for long-form synthesis.\n\n## Findings\n\n- Model quality is stable.\n\n## Risks and Open Questions\n\n- Cost should be tracked.\n\n## Recommendations\n\n- Adopt as default for parser tasks.",
        reference_notes="## Source References\n\n- Source: Vendor docs (src-1)",
        editor_feedback="Tighten the risk framing.",
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=["wiki-1"],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={"opinion_notes": "Bias toward operational simplicity.", "style_notes": "Write for decision-makers."},
    )

    content = export_markdown(asset)

    assert "> [!abstract] Brief Overview" in content
    assert "## Brief Snapshot" in content
    assert "## Recommended Decision" in content
    assert "## Full Brief" in content
    assert "## Appendix C — Evidence and References" in content
    assert "## Appendix A — Working Outline" in content


def test_check_readiness_requires_enough_references_for_knowledge_pack():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-pack-1",
        user_id="user-1",
        asset_type="knowledge_pack",
        status="draft",
        title="Agent Memory Pack",
        brief="Onboarding pack for agent memory work.",
        outline="## Overview",
        draft_content="## Overview\n\nSomething\n\n## What’s Included\n\nSomething\n\n## Recommended Reading Path\n\nSomething",
        reference_notes=None,
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    ready, blocking, _warnings, _suggestions = check_readiness(asset)

    assert ready is False
    assert "Knowledge pack requires at least three attached references" in blocking
    assert "Knowledge pack requires references before export" in blocking


def test_check_readiness_requires_pack_structure_sections():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-pack-2",
        user_id="user-1",
        asset_type="knowledge_pack",
        status="draft",
        title="Agent Memory Pack",
        brief="Onboarding pack for agent memory work.",
        outline="## Overview",
        draft_content="## Overview\n\nSomething\n\n## Core Themes\n\nSomething",
        reference_notes="## Source References\n\n- Source: Internal note (src-1)",
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    ready, blocking, _warnings, suggestions = check_readiness(asset)

    assert ready is False
    assert "Knowledge pack requires a 'what’s included' section" in blocking
    assert "Knowledge pack requires a 'recommended reading path' section" in blocking
    assert any("open questions" in item for item in suggestions)


def test_export_markdown_uses_knowledge_pack_template():
    from pkg.services.application.blog_generation import export_markdown

    asset = Asset(
        id="asset-pack-1",
        user_id="user-1",
        asset_type="knowledge_pack",
        status="ready_to_export",
        title="Agent Memory Pack",
        brief="Onboarding pack for agent memory work.",
        outline="# Agent Memory Pack\n\n## Overview\n\n- Summary",
        draft_content="# Agent Memory Pack\n\n## Overview\n\nIntro\n\n## What’s Included\n\n- Notes\n\n## Core Themes\n\n- Theme\n\n## Recommended Reading Path\n\n- Step 1",
        reference_notes="## Source References\n\n- Source: Internal note (src-1)",
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    content = export_markdown(asset)

    assert "> [!info] Knowledge Pack" in content
    assert "## Pack Snapshot" in content
    assert "## What’s Included" in content
    assert "## Recommended Reading Path" in content
    assert "## Appendix B — References" in content


def test_check_readiness_requires_newsletter_sections_and_references():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-news-1",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="Agent Systems Weekly",
        brief="Weekly roundup for agent systems work.",
        outline="## Issue Overview",
        draft_content="## Issue Overview\n\nIntro\n\n## Why It Matters\n\nSomething",
        reference_notes=None,
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    ready, blocking, _warnings, suggestions = check_readiness(asset)

    assert ready is False
    assert "Newsletter issue requires at least three attached references" in blocking
    assert "Newsletter issue requires references before export" in blocking
    assert "Newsletter issue requires an 'editor’s note' section" in blocking
    assert "Newsletter issue requires a 'featured items' section" in blocking
    assert "Newsletter issue requires a 'recommended next reads' section" in blocking
    assert any("issue overview" in item for item in suggestions) is False


def test_export_markdown_uses_newsletter_template():
    from pkg.services.application.blog_generation import export_markdown

    asset = Asset(
        id="asset-news-1",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="ready_to_export",
        title="Agent Systems Weekly",
        brief="Weekly roundup for agent systems work.",
        outline="# Agent Systems Weekly\n\n## Issue Overview\n\n- Summary",
        draft_content="# Agent Systems Weekly\n\n## Issue Overview\n\nIntro\n\n## Editor’s Note\n\nNote\n\n## Featured Items\n\n- Item\n\n## Why It Matters\n\nMatters\n\n## Recommended Next Reads\n\n- Read next",
        reference_notes="## Source References\n\n- Source: Internal note (src-1)",
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    content = export_markdown(asset)

    assert "> [!tip] Newsletter Issue" in content
    assert "## Issue Snapshot" in content
    assert "## Editor’s Note" in content
    assert "## Featured Items" in content
    assert "## Recommended Next Reads" in content
    assert "## Appendix B — References" in content


def test_check_readiness_requires_topic_report_structure_and_wiki():
    from pkg.services.application.blog_generation import check_readiness

    asset = Asset(
        id="asset-report-1",
        user_id="user-1",
        asset_type="topic_report",
        status="draft",
        title="Agent Memory Report",
        brief="Report on agent memory systems.",
        outline="## Executive Summary",
        draft_content="## Executive Summary\n\nSummary\n\n## Findings\n\nFinding",
        reference_notes=None,
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    ready, blocking, _warnings, suggestions = check_readiness(asset)

    assert ready is False
    assert "Topic report requires at least one wiki reference" in blocking
    assert "Topic report requires at least three attached references" in blocking
    assert "Topic report requires references before export" in blocking
    assert "Topic report requires a 'key themes' section" in blocking
    assert "Topic report requires a 'recommendations' section" in blocking
    assert any("topic overview" in item for item in suggestions)


def test_export_markdown_uses_topic_report_template():
    from pkg.services.application.blog_generation import export_markdown

    asset = Asset(
        id="asset-report-1",
        user_id="user-1",
        asset_type="topic_report",
        status="ready_to_export",
        title="Agent Memory Report",
        brief="Report on agent memory systems.",
        outline="# Agent Memory Report\n\n## Executive Summary\n\n- Summary",
        draft_content="# Agent Memory Report\n\n## Executive Summary\n\nSummary\n\n## Topic Overview\n\nOverview\n\n## Key Themes\n\n- Theme\n\n## Findings\n\n- Finding\n\n## Risks and Gaps\n\n- Gap\n\n## Recommendations and Next Steps\n\n- Next",
        reference_notes="## Source References\n\n- Source: Internal note (src-1)",
        editor_feedback=None,
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=["wiki-1"],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    content = export_markdown(asset)

    assert "> [!summary] Topic Report" in content
    assert "## Report Snapshot" in content
    assert "## Executive Summary" in content
    assert "## Key Themes" in content
    assert "## Recommendations and Next Steps" in content
    assert "## Appendix B — References" in content


@pytest.mark.asyncio
async def test_generate_outline_falls_back_to_research_brief_template():
    from pkg.services.application.blog_generation import generate_outline

    asset = Asset(
        id="asset-brief-1",
        user_id="user-1",
        asset_type="research_brief",
        status="draft",
        title="AI Tooling Brief",
        brief="Assess trade-offs and recommendation",
        outline=None,
        draft_content=None,
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    session = AsyncMock()
    session.execute.side_effect = []

    outline = await generate_outline(session, asset=asset)

    assert "## Executive Summary" in outline
    assert "## Key Findings" in outline
    assert "## Recommendations" in outline
