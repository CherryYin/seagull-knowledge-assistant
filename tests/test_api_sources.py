"""Tests for sources API endpoints (/sources/*)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# GET /sources/{source_id}
# ---------------------------------------------------------------------------
class TestGetSource:
    def test_found(self, client, mock_session, fake_user):
        source = _make_source("src-1", fake_user.id)
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [source, category]

        resp = client.get("/sources/src-1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "src-1"
        assert data["title"] == "Test Source"

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.get("/sources/nonexistent")
        assert resp.status_code == 404

    def test_wrong_user_not_shared(self, client, mock_session):
        source = _make_source("src-1", "other-user", is_shared=False)
        mock_session.get.return_value = source

        resp = client.get("/sources/src-1")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /sources (list)
# ---------------------------------------------------------------------------
class TestListSources:
    def test_empty(self, client, mock_session):
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [mock_count, mock_rows]

        resp = client.get("/sources")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []


# ---------------------------------------------------------------------------
# DELETE /sources/{source_id}
# ---------------------------------------------------------------------------
class TestDeleteSource:
    def test_success(self, client, mock_session, fake_user):
        source = _make_source("src-1", fake_user.id, file_path=None)
        # get calls: source, embedding
        mock_session.get.side_effect = [source, None]
        # execute for chunks query
        mock_chunks = MagicMock()
        mock_chunks.scalars.return_value = []
        mock_session.execute.return_value = mock_chunks

        resp = client.delete("/sources/src-1")
        assert resp.status_code == 204
        mock_session.commit.assert_awaited()

    def test_not_found(self, client, mock_session):
        mock_session.get.return_value = None

        resp = client.delete("/sources/nonexistent")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_source(source_id: str, user_id: str, is_shared: bool = False, file_path: str | None = None):
    source = MagicMock(spec=[])  # spec=[] prevents auto-attribute creation
    source.id = source_id
    source.user_id = user_id
    source.category_id = 1
    source.category_name = None
    source.title = "Test Source"
    source.source_type = "article"
    source.url = "https://example.com"
    source.raw_content = "Content"
    source.file_path = file_path
    source.content_hash = "abc123"
    source.metadata_ = {}
    source.is_shared = is_shared
    source.ingested_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    source.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    source.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return source
