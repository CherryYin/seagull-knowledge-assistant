from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.memory import MemoryNode
from pkg.models.wiki import WikiPage
from pkg.services.wiki_recompile import suggest_wiki_recompile_for_trigger


@pytest.mark.asyncio
async def test_suggest_wiki_recompile_for_memory_marks_related_wiki():
    memory = MemoryNode(
        id="mem-topic-memory-tree",
        user_id="user-1",
        node_type="topic",
        scope_id="memory-tree",
        level="topic",
        title="Topic Memory - Memory Tree",
        summary="Memory tree changed",
        content="Memory Tree now includes source memory and topic memory.",
        child_node_ids=[],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=None,
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
        derived_from_sources=["src-1"],
        open_questions=[],
        confidence_score=None,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    attached_rows = MagicMock()
    attached_rows.scalars.return_value = []
    trigger_rows = MagicMock()
    trigger_rows.scalars.return_value = [wiki]
    existing_rows = MagicMock()
    existing_rows.scalar_one_or_none.return_value = None

    session = AsyncMock()
    session.get = AsyncMock(return_value=memory)
    session.execute = AsyncMock(side_effect=[attached_rows, trigger_rows, existing_rows])
    session.add = MagicMock()

    suggestions = await suggest_wiki_recompile_for_trigger(
        session,
        user_id="user-1",
        trigger_type="memory",
        trigger_id="mem-topic-memory-tree",
    )

    assert len(suggestions) == 1
    assert suggestions[0].wiki_id == "wiki-memory-tree"
    assert suggestions[0].trigger_type == "memory"
    assert suggestions[0].trigger_id == "mem-topic-memory-tree"
    assert suggestions[0].status == "pending"
    assert wiki.needs_recompile is True
    session.add.assert_called_once_with(suggestions[0])


@pytest.mark.asyncio
async def test_suggest_wiki_recompile_ignores_missing_trigger():
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)

    suggestions = await suggest_wiki_recompile_for_trigger(
        session,
        user_id="user-1",
        trigger_type="memory",
        trigger_id="missing",
    )

    assert suggestions == []
