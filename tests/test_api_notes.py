"""Tests for notes API endpoints (/notes/*)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# GET /notes/{note_id}
# ---------------------------------------------------------------------------
class TestGetNote:
    def test_found(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [note, category]

        resp = client.get("/notes/note-1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "note-1"
        assert data["title"] == "Test Note"

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.get("/notes/nonexistent")
        assert resp.status_code == 404

    def test_wrong_user(self, client, mock_session):
        note = _make_note("note-1", "other-user")
        mock_session.get.return_value = note

        resp = client.get("/notes/note-1")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /notes (list)
# ---------------------------------------------------------------------------
class TestListNotes:
    def test_empty(self, client, mock_session):
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [mock_count, mock_rows]

        resp = client.get("/notes")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []


# ---------------------------------------------------------------------------
# DELETE /notes/{note_id}
# ---------------------------------------------------------------------------
class TestDeleteNote:
    def test_success(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id, file_path=None)
        mock_session.get.side_effect = [note, None]  # note, then embedding

        resp = client.delete("/notes/note-1")
        assert resp.status_code == 204
        mock_session.delete.assert_awaited()
        mock_session.commit.assert_awaited()

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.delete("/notes/nonexistent")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_note(note_id: str, user_id: str, file_path: str | None = None):
    note = MagicMock(spec=[])  # spec=[] prevents auto-attribute creation
    note.id = note_id
    note.user_id = user_id
    note.category_id = 1
    note.category_name = None
    note.title = "Test Note"
    note.note_type = "concept"
    note.domains = ["AI"]
    note.tags = ["test"]
    note.abstract = "Summary"
    note.content = "Full content"
    note.project = None
    note.status = "active"
    note.confidence = "high"
    note.source_ids = []
    note.file_path = file_path
    note.word_count = 2
    note.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    note.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return note
