from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.services.foundation.wiki_mining import run_wiki_mining


@pytest.mark.asyncio
async def test_run_wiki_mining_generates_insights_and_article():
    now = datetime(2026, 6, 8, tzinfo=timezone.utc)
    source = Source(
        id="src-1",
        user_id="user-1",
        is_shared=False,
        category_id=1,
        title="LLM memory architecture",
        source_type="web",
        url="https://example.com/llm-memory",
        content_hash=None,
        raw_content="LLM memory architecture connects wiki, sources, and review loops.",
        file_path=None,
        ingested_at=now,
        metadata_={},
    )
    note = Note(
        id="note-1",
        user_id="user-1",
        category_id=1,
        title="Wiki review note",
        note_type="summary",
        domains=[],
        tags=[],
        abstract="Need a better wiki review loop.",
        content="The review loop should connect sources and wiki candidates.",
        project=None,
        status="seed",
        confidence="medium",
        source_ids=["src-1"],
        file_path=None,
        word_count=20,
        expires_at=None,
        kept_at=None,
        created_at=now,
        updated_at=now,
    )
    memory = MemoryNode(
        id="mem-1",
        user_id="user-1",
        node_type="topic",
        scope_id="wiki-review",
        level="topic",
        title="Wiki review memory",
        summary="Stable review knowledge",
        content="Knowledge tree nodes can guide wiki mining.",
        child_node_ids=[],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=0.8,
        created_at=now,
        updated_at=now,
    )
    wiki = WikiPage(
        id="wiki-1",
        user_id="user-1",
        title="Wiki Review",
        page_type="topic",
        summary="How wiki review works",
        content="Existing stable context for review and knowledge mining.",
        domains=[],
        tags=[],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        open_questions=[],
        confidence_score=0.8,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=now,
        created_at=now,
        updated_at=now,
    )

    rows = []
    for scalars in ([source], [note], [memory], [source], [note], [memory], [wiki]):
        result = MagicMock()
        result.scalars.return_value = scalars
        rows.append(result)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=rows)
    session.flush = AsyncMock(side_effect=lambda: None)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock(side_effect=lambda obj: setattr(obj, "id", getattr(obj, "id", None) or len(session.add.mock_calls)))

    result = await run_wiki_mining(session, user_id="user-1")

    assert result.run.status == "completed"
    assert len(result.insights) >= 1
    assert len(result.articles) == 1
    assert result.insights[0].evidence_refs
    assert result.articles[0].evidence_refs
    session.commit.assert_awaited()
