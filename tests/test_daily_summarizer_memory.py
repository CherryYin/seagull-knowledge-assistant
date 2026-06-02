from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.daily_summarizer import _memory_node_id, _note_id, summarize_temporary_notes


@pytest.mark.asyncio
@patch("pkg.services.daily_summarizer.get_storage_service")
@patch("pkg.services.daily_summarizer.get_embedding_service")
@patch("pkg.services.daily_summarizer.upsert_memory_embedding", new_callable=AsyncMock)
@patch("pkg.services.llm.create_async_client")
async def test_daily_summary_writes_memory_node(
    mock_llm_client, mock_memory_embedding, mock_embedding_service, mock_storage
):
    note = _make_note("note-temp-1")

    read_session = AsyncMock()
    read_rows = MagicMock()
    read_rows.scalars.return_value = [note]
    read_session.execute.return_value = read_rows

    write_session = AsyncMock()
    category_rows = MagicMock()
    category = MagicMock()
    category.id = 1
    category_rows.scalar.return_value = category
    write_session.execute.return_value = category_rows
    write_session.get = AsyncMock(side_effect=[None, None, None, note])
    write_session.add = MagicMock()

    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(side_effect=[read_session, write_session])
    session_cm.__aexit__ = AsyncMock(return_value=None)

    storage = MagicMock()
    storage.build_object_key.return_value = "notes/note.md"
    storage.upload_bytes = AsyncMock(return_value="minio://notes/note.md")
    mock_storage.return_value = storage

    emb = MagicMock()
    emb.embed_text = AsyncMock(return_value=[0.1, 0.2])
    mock_embedding_service.return_value = emb

    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="# Daily\n\nSummary"))]
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=response)
    mock_llm_client.return_value = (client, "test-model")

    with patch("pkg.services.daily_summarizer.async_session", return_value=session_cm):
        note_id = await summarize_temporary_notes("user-12345678")

    assert note_id == _note_id("user-12345678", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    added = [call.args[0] for call in write_session.add.call_args_list]
    memory_nodes = [item for item in added if getattr(item, "id", "") == _memory_node_id("user-12345678", datetime.now(timezone.utc).strftime("%Y-%m-%d"))]
    assert memory_nodes
    assert memory_nodes[0].node_type == "global"
    assert memory_nodes[0].level == "day"
    assert memory_nodes[0].derived_from_notes == ["note-temp-1"]
    mock_memory_embedding.assert_awaited_once_with(write_session, memory_nodes[0])
    assert note.status == "archived"
    write_session.commit.assert_awaited()


def _make_note(note_id: str):
    note = MagicMock(spec=[])
    note.id = note_id
    note.user_id = "user-12345678"
    note.title = "Temporary memory"
    note.content = "Remember this"
    note.source_ids = ["src-1"]
    note.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    note.status = "temporary"
    return note
