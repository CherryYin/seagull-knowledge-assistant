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
    assert any("recommendations" in item for item in suggestions)


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
