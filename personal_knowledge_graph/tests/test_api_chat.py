"""Tests for chat sessions API endpoints (/chat-sessions/*)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# POST /chat-sessions
# ---------------------------------------------------------------------------
class TestCreateSession:
    def test_create_default(self, client, mock_session):
        mock_session.refresh = _refresh_with_timestamps(mock_session.refresh)

        resp = client.post("/chat-sessions", json={"title": "My Chat"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["title"] == "My Chat"
        mock_session.add.assert_called_once()
        mock_session.commit.assert_awaited()


# ---------------------------------------------------------------------------
# GET /chat-sessions
# ---------------------------------------------------------------------------
class TestListSessions:
    def test_empty(self, client, mock_session):
        mock_result = MagicMock()
        mock_result.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [mock_result, mock_rows]

        resp = client.get("/chat-sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []


# ---------------------------------------------------------------------------
# GET /chat-sessions/{id}
# ---------------------------------------------------------------------------
class TestGetSession:
    def test_found(self, client, mock_session, fake_user):
        session_obj = _make_chat_session("s-1", fake_user.id)
        mock_session.get.return_value = session_obj

        resp = client.get("/chat-sessions/s-1")
        assert resp.status_code == 200
        assert resp.json()["id"] == "s-1"

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.get("/chat-sessions/nonexistent")
        assert resp.status_code == 404

    def test_wrong_user(self, client, mock_session):
        session_obj = _make_chat_session("s-1", "other-user")
        mock_session.get.return_value = session_obj

        resp = client.get("/chat-sessions/s-1")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /chat-sessions/{id}
# ---------------------------------------------------------------------------
class TestDeleteSession:
    def test_success(self, client, mock_session, fake_user):
        session_obj = _make_chat_session("s-1", fake_user.id)
        mock_session.get.return_value = session_obj

        resp = client.delete("/chat-sessions/s-1")
        assert resp.status_code == 204
        mock_session.delete.assert_awaited()
        mock_session.commit.assert_awaited()

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.delete("/chat-sessions/nonexistent")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_chat_session(session_id: str, user_id: str):
    obj = MagicMock()
    obj.id = session_id
    obj.user_id = user_id
    obj.title = "Test Session"
    obj.messages = []
    obj.is_ephemeral = False
    obj.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    obj.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return obj


def _refresh_with_timestamps(original_refresh):
    """Add timestamps to mocked model objects on refresh."""
    async def _refresh(obj, *args, **kwargs):
        if not hasattr(obj, "created_at") or obj.created_at is None:
            obj.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        if not hasattr(obj, "updated_at") or obj.updated_at is None:
            obj.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return _refresh
