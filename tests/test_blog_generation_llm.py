from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.application.asset import Asset
from pkg.services.application.blog_generation import generate_draft, generate_outline


@pytest.mark.asyncio
async def test_generate_outline_uses_llm_when_available():
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft",
        brief="Write about retrieval",
        source_refs=[],
        note_refs=[],
        memory_refs=[],
        wiki_refs=[],
    )
    session = AsyncMock()
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content="# Outline\n\n## Section"))]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    with patch("pkg.services.application.blog_generation.create_async_client", return_value=(mock_client, "test-model")):
        outline = await generate_outline(session, asset=asset)

    assert outline.startswith("# Outline")


@pytest.mark.asyncio
async def test_generate_draft_falls_back_when_llm_fails():
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft",
        brief="Write about retrieval",
        outline="## Outline",
        source_refs=[],
        note_refs=[],
        memory_refs=[],
        wiki_refs=[],
    )
    session = AsyncMock()

    with patch("pkg.services.application.blog_generation.create_async_client", side_effect=RuntimeError("llm unavailable")):
        draft = await generate_draft(session, asset=asset)

    assert "# Draft" in draft
    assert "## References" in draft


@pytest.mark.asyncio
async def test_generate_draft_falls_back_when_llm_returns_empty_content():
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="newsletter_issue",
        status="draft",
        title="Weekly Newsletter",
        brief="Recent source summary",
        outline="## Issue Overview",
        source_refs=[],
        note_refs=[],
        memory_refs=[],
        wiki_refs=[],
    )
    session = AsyncMock()
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content="   "))]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    with patch("pkg.services.application.blog_generation.create_async_client", return_value=(mock_client, "test-model")):
        draft = await generate_draft(session, asset=asset)

    assert "# Weekly Newsletter" in draft
    assert "## Issue Overview" in draft
    assert "## Featured Items" in draft
