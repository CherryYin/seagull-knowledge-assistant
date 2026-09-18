from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.source import Source
from pkg.models.wiki import WikiPage
from pkg.schemas.wiki import WikiSuggestRequest
from pkg.services.foundation.wiki_recompile import suggest_wiki_recompile_for_trigger


def test_wiki_suggest_request_rejects_memory_trigger():
    with pytest.raises(ValueError):
        WikiSuggestRequest(trigger_type="memory", trigger_id="mem-1")


@pytest.mark.asyncio
async def test_suggest_wiki_recompile_for_source_marks_related_wiki():
    source = Source(
        id="src-memory-tree",
        user_id="user-1",
        category_id=1,
        title="Memory Tree",
        source_type="article",
        raw_content="Memory Tree now includes source memory and topic memory.",
        metadata_={},
    )
    wiki = WikiPage(
        id="wiki-memory-tree",
        user_id="user-1",
        title="Memory Tree",
        page_type="topic",
        summary="Source memory and topic memory design",
        content="Current wiki",
        domains=[],
        tags=["memory"],
        derived_from_notes=[],
        derived_from_sources=["src-memory-tree"],
        open_questions=[],
        confidence_score=None,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    trigger_rows = MagicMock()
    trigger_rows.scalars.return_value = [wiki]
    existing_rows = MagicMock()
    existing_rows.scalar_one_or_none.return_value = None

    session = AsyncMock()
    session.get = AsyncMock(return_value=source)
    session.execute = AsyncMock(side_effect=[trigger_rows, existing_rows])
    session.add = MagicMock()

    suggestions = await suggest_wiki_recompile_for_trigger(
        session,
        user_id="user-1",
        trigger_type="source",
        trigger_id="src-memory-tree",
    )

    assert len(suggestions) == 1
    assert suggestions[0].wiki_id == "wiki-memory-tree"
    assert suggestions[0].trigger_type == "source"
    assert suggestions[0].trigger_id == "src-memory-tree"
    assert suggestions[0].status == "pending"
    assert "related_memory_ids" not in suggestions[0].metadata_
    assert wiki.needs_recompile is True
    session.add.assert_called_once_with(suggestions[0])


@pytest.mark.asyncio
async def test_suggest_wiki_recompile_ignores_missing_trigger():
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)

    suggestions = await suggest_wiki_recompile_for_trigger(
        session,
        user_id="user-1",
        trigger_type="source",
        trigger_id="missing",
    )

    assert suggestions == []


@pytest.mark.asyncio
async def test_suggest_wiki_recompile_filters_low_score_suggestions():
    source = Source(
        id="src-low-score",
        user_id="user-1",
        category_id=1,
        title="Alpha",
        source_type="article",
        raw_content="Alpha mention only.",
        metadata_={},
    )
    wiki = WikiPage(
        id="wiki-alpha",
        user_id="user-1",
        title="Beta",
        page_type="topic",
        summary="Unrelated summary",
        content="Current wiki",
        domains=[],
        tags=[],
        derived_from_notes=[],
        derived_from_sources=[],
        open_questions=[],
        confidence_score=None,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    trigger_rows = MagicMock()
    trigger_rows.scalars.return_value = [wiki]

    session = AsyncMock()
    session.get = AsyncMock(return_value=source)
    session.execute = AsyncMock(side_effect=[trigger_rows])
    session.add = MagicMock()

    suggestions = await suggest_wiki_recompile_for_trigger(
        session,
        user_id="user-1",
        trigger_type="source",
        trigger_id="src-low-score",
    )

    assert suggestions == []
    assert wiki.needs_recompile is False
    session.add.assert_not_called()
