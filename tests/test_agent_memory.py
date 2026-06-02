from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.models.agent_run import AgentRun
from pkg.services.agent_memory import (
    create_memory_from_note,
    create_pending_conversation_memory,
    extract_pending_memory_from_agent_run,
    record_agent_memory_use,
)


@pytest.mark.asyncio
async def test_record_agent_memory_use_writes_event_and_edges():
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    node = MagicMock()
    node.id = "mem-1"
    node.title = "Memory One"
    node.user_id = "user-1"
    rows = MagicMock()
    rows.scalars.return_value = [node]
    mock_session.execute.return_value = rows

    with patch("pkg.services.agent_memory.upsert_memory_edge", new_callable=AsyncMock) as mock_edge:
        await record_agent_memory_use(
            mock_session,
            user_id="user-1",
            run_id="run-1",
            memory_node_ids=["mem-1", "mem-1"],
            action="search_memory",
            query="memory",
        )

    event = mock_session.add.call_args.args[0]
    assert event.event_type == "memory_used"
    assert event.metadata_["memory_node_ids"] == ["mem-1"]
    assert node.metadata_["usage_count"] == 1
    assert node.metadata_["last_used_action"] == "search_memory"
    mock_edge.assert_awaited_once()
    assert mock_edge.await_args.kwargs["to_kind"] == "agent_run"
    assert mock_edge.await_args.kwargs["edge_type"] == "mentions"


@pytest.mark.asyncio
async def test_create_pending_conversation_memory_caps_confidence_and_requires_review():
    mock_session = AsyncMock()
    mock_session.get.return_value = None
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()

    with patch("pkg.services.agent_memory.upsert_memory_embedding", new_callable=AsyncMock), patch("pkg.services.agent_memory.upsert_memory_edge", new_callable=AsyncMock):
        node = await create_pending_conversation_memory(
            mock_session,
            user_id="user-12345678",
            title="Remember this",
            summary="User prefers short answers",
            content="The user explicitly asked for concise responses.",
            run_id="run-1",
            confidence_score=0.95,
        )

    assert node.confidence_score == 0.6
    assert node.metadata_["status"] == "pending_review"
    assert node.metadata_["requires_review"] is True
    assert node.metadata_["created_by_agent_run_id"] == "run-1"


@pytest.mark.asyncio
async def test_extract_pending_memory_from_agent_run_requires_explicit_memory_intent():
    run = AgentRun(user_id="user-1", agent_type="action", task="Summarize this discussion")
    run.id = "run-1"
    mock_session = AsyncMock()

    result = await extract_pending_memory_from_agent_run(mock_session, run=run, result_preview="A long enough response " * 20)
    assert result is None


@pytest.mark.asyncio
async def test_extract_pending_memory_from_agent_run_creates_for_memory_intent():
    run = AgentRun(user_id="user-1", agent_type="action", task="请记住这个偏好")
    run.id = "run-1"
    mock_session = AsyncMock()
    mock_node = MagicMock()

    with patch("pkg.services.agent_memory.create_pending_conversation_memory", new_callable=AsyncMock, return_value=mock_node) as mock_create:
        result = await extract_pending_memory_from_agent_run(
            mock_session,
            run=run,
            result_preview="用户明确表示希望保存这个偏好，未来回答应该更加简洁并优先给结论。" * 4,
        )

    assert result is mock_node
    assert mock_create.await_args.kwargs["confidence_score"] == 0.35
    assert mock_create.await_args.kwargs["run_id"] == "run-1"


@pytest.mark.asyncio
async def test_create_memory_from_note_creates_active_document_memory():
    mock_session = AsyncMock()
    note = MagicMock()
    note.id = "note-1"
    note.user_id = "user-1"
    note.note_type = "concept"
    note.title = "Generated Report"
    note.abstract = "Report summary"
    note.content = "Report body " * 20
    note.tags = ["from-document"]
    note.source_ids = ["src-1"]
    mock_session.get.side_effect = [note, None]
    mock_session.add = MagicMock()

    with patch("pkg.services.agent_memory.upsert_memory_embedding", new_callable=AsyncMock), patch("pkg.services.agent_memory.upsert_memory_edge", new_callable=AsyncMock) as mock_edge:
        node = await create_memory_from_note(
            mock_session,
            user_id="user-1",
            note_id="note-1",
            memory_kind="document",
            confidence_score=0.65,
        )

    assert node is not None
    assert node.level == "document"
    assert node.metadata_["status"] == "active"
    assert node.derived_from_notes == ["note-1"]
    assert node.derived_from_sources == ["src-1"]
    mock_edge.assert_awaited_once()
