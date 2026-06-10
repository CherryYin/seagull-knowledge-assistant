from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from pkg.models.application.asset import Asset
from pkg.schemas.application.asset import AssetCreate, AssetUpdate
from pkg.services.application.assets import create_asset, update_asset


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
            body=AssetCreate(title="Draft post", source_refs=["src-1"], note_refs=["note-1"], wiki_refs=["wiki-1"], opinion_notes="Take a strong stance", style_notes="Write analytically"),
        )

    assert asset.title == "Draft post"
    assert asset.asset_type == "blog_post"
    assert asset.status == "draft"
    assert asset.metadata_["opinion_notes"] == "Take a strong stance"
    assert asset.metadata_["style_notes"] == "Write analytically"
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=[],
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
        memory_refs=["mem-1"],
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
        memory_refs=["mem-1"],
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
        memory_refs=[],
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
