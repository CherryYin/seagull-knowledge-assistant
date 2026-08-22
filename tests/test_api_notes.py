"""Tests for notes API endpoints (/notes/*)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

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

    def test_default_excludes_digest_notes(self, client, mock_session):
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [mock_count, mock_rows]

        resp = client.get("/notes")
        assert resp.status_code == 200

        first_stmt = mock_session.execute.await_args_list[0].args[0]
        assert "notes.note_type !=" in str(first_stmt)

    def test_explicit_digest_filter_allowed(self, client, mock_session):
        cleanup_rows = MagicMock()
        cleanup_rows.scalars.return_value = []
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [cleanup_rows, mock_count, mock_rows]

        resp = client.get("/notes?note_type=digest")
        assert resp.status_code == 200

        count_stmt = mock_session.execute.await_args_list[1].args[0]
        assert "notes.note_type !=" not in str(count_stmt)

    def test_digest_cleanup_deletes_expired_pending_notes(self, client, mock_session, fake_user):
        expired = _make_note("digest-expired", fake_user.id)
        expired.note_type = "digest"
        expired.status = "pending_review"
        expired.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        cleanup_rows = MagicMock()
        cleanup_rows.scalars.return_value = [expired]
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [cleanup_rows, mock_count, mock_rows]
        mock_session.get.return_value = None

        resp = client.get("/notes?note_type=digest")

        assert resp.status_code == 200
        mock_session.delete.assert_awaited_with(expired)
        mock_session.commit.assert_awaited()

    @patch("pkg.api.notes.get_storage_service")
    def test_digest_cleanup_deletes_minio_object(self, mock_storage_factory, client, mock_session, fake_user):
        expired = _make_note("digest-expired", fake_user.id, file_path="minio://bucket/notes/digest-expired/note.md")
        expired.note_type = "digest"
        expired.status = "pending_review"
        expired.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        storage = MagicMock()
        storage.delete_object = AsyncMock()
        mock_storage_factory.return_value = storage
        cleanup_rows = MagicMock()
        cleanup_rows.scalars.return_value = [expired]
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [cleanup_rows, mock_count, mock_rows]
        mock_session.get.return_value = None

        resp = client.get("/notes?note_type=digest")

        assert resp.status_code == 200
        storage.delete_object.assert_awaited_once_with("minio://bucket/notes/digest-expired/note.md")

    @patch("pkg.api.notes.get_storage_service")
    def test_digest_cleanup_skips_non_minio_object(self, mock_storage_factory, client, mock_session, fake_user):
        expired = _make_note("digest-expired", fake_user.id, file_path="/tmp/digest.md")
        expired.note_type = "digest"
        expired.status = "pending_review"
        expired.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        storage = MagicMock()
        storage.delete_object = AsyncMock()
        mock_storage_factory.return_value = storage
        cleanup_rows = MagicMock()
        cleanup_rows.scalars.return_value = [expired]
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [cleanup_rows, mock_count, mock_rows]
        mock_session.get.return_value = None

        resp = client.get("/notes?note_type=digest")

        assert resp.status_code == 200
        storage.delete_object.assert_not_called()

    @patch("pkg.api.notes.get_storage_service")
    def test_digest_cleanup_continues_on_storage_delete_error(self, mock_storage_factory, client, mock_session, fake_user):
        expired = _make_note("digest-expired", fake_user.id, file_path="minio://bucket/notes/digest-expired/note.md")
        expired.note_type = "digest"
        expired.status = "pending_review"
        expired.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        storage = MagicMock()
        storage.delete_object = AsyncMock(side_effect=RuntimeError("boom"))
        mock_storage_factory.return_value = storage
        cleanup_rows = MagicMock()
        cleanup_rows.scalars.return_value = [expired]
        mock_count = MagicMock()
        mock_count.scalar.return_value = 0
        mock_rows = MagicMock()
        mock_rows.scalars.return_value = []
        mock_session.execute.side_effect = [cleanup_rows, mock_count, mock_rows]
        mock_session.get.return_value = None

        resp = client.get("/notes?note_type=digest")

        assert resp.status_code == 200
        mock_session.delete.assert_awaited_with(expired)


@pytest.mark.asyncio
@patch("pkg.api.notes.get_storage_service")
async def test_delete_expired_digest_notes_returns_exact_cleanup_stats(mock_storage_factory, mock_session, fake_user):
    from pkg.api.notes import delete_expired_digest_notes

    expired = _make_note(
        "digest-expired",
        fake_user.id,
        file_path="minio://bucket/notes/digest-expired/note.md",
    )
    expired.note_type = "digest"
    expired.status = "pending_review"
    expired.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    rows = MagicMock()
    rows.scalars.return_value = [expired]
    mock_session.execute.return_value = rows
    mock_session.get.return_value = None
    storage = MagicMock(delete_object=AsyncMock())
    mock_storage_factory.return_value = storage

    result = await delete_expired_digest_notes(mock_session, user_id=fake_user.id)

    assert result == {
        "notes_deleted": 1,
        "storage_objects_deleted": 1,
        "storage_delete_errors": 0,
    }
    storage.delete_object.assert_awaited_once_with(expired.file_path)


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
# POST /notes/{note_id}/merge-digest
# ---------------------------------------------------------------------------
class TestMergeDigest:
    @patch("pkg.api.notes.put_note_markdown_oss", new_callable=AsyncMock)
    @patch("pkg.api.notes.get_embedding_service")
    def test_success(self, mock_embedding_service, mock_put, client, mock_session, fake_user):
        target = _make_note("digest-1", fake_user.id)
        target.note_type = "digest"
        target.status = "pending_review"
        target.title = "RSS: AI - 2026-01-01"
        target.content = "First digest"
        target.tags = ["rss-summary"]
        target.domains = ["rss"]
        target.source_ids = ["src-1"]

        source = _make_note("digest-2", fake_user.id)
        source.note_type = "digest"
        source.status = "pending_review"
        source.title = "RSS: AI - 2026-01-02"
        source.content = "Second digest"
        source.tags = ["auto-generated"]
        source.domains = ["rss", "ai"]
        source.source_ids = ["src-2"]

        rows = MagicMock()
        rows.scalars.return_value = [source]
        category = MagicMock()
        category.name = "General"
        emb = MagicMock()
        mock_session.get.side_effect = [target, category, emb, emb]
        mock_session.execute.return_value = rows
        mock_put.return_value = "minio://notes/digest-1/note.md"
        emb_svc = MagicMock()
        emb_svc.embed_text = AsyncMock(return_value=[0.1, 0.2])
        mock_embedding_service.return_value = emb_svc

        resp = client.post("/notes/digest-1/merge-digest", json={"source_ids": ["digest-2"]})

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "digest-1"
        assert data["status"] == "kept"
        assert "merged-digest" in data["tags"]
        assert "src-1" in data["source_ids"]
        assert "src-2" in data["source_ids"]
        assert "First digest" in target.content
        assert "Second digest" in target.content
        mock_session.delete.assert_awaited()
        mock_session.commit.assert_awaited()

    def test_target_must_be_digest(self, client, mock_session, fake_user):
        target = _make_note("note-1", fake_user.id)
        mock_session.get.return_value = target

        resp = client.post("/notes/note-1/merge-digest", json={"source_ids": ["digest-2"]})

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
    note.expires_at = None
    note.kept_at = None
    note.is_pinned = False
    note.content_versions = None
    note.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    note.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return note


# ---------------------------------------------------------------------------
# POST /notes/{note_id}/pin
# ---------------------------------------------------------------------------
class TestTogglePin:
    def test_pin_toggle(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        note.is_pinned = False
        mock_session.get.side_effect = [note, MagicMock(name="category", name_="General")] if False else [note]
        # category lookup happens after commit+refresh via session.get(Category,...)
        cat = MagicMock()
        cat.name = "General"
        mock_session.get.side_effect = [note, cat]

        resp = client.post("/notes/note-1/pin")
        assert resp.status_code == 200
        assert resp.json()["is_pinned"] is True
        assert note.is_pinned is True
        mock_session.commit.assert_awaited()

    def test_pin_wrong_user(self, client, mock_session):
        note = _make_note("note-1", "other-user")
        mock_session.get.return_value = note

        resp = client.post("/notes/note-1/pin")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /notes/{note_id}/versions + restore
# ---------------------------------------------------------------------------
class TestNoteVersions:
    def test_list_versions(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        note.content_versions = [
            {"title": "Old", "content": "old body", "created_at": "2026-01-01T00:00:00+00:00"},
            {"title": "Newer", "content": "newer body", "created_at": "2026-01-02T00:00:00+00:00"},
        ]
        mock_session.get.return_value = note

        resp = client.get("/notes/note-1/versions")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["index"] == 0
        assert data[0]["content"] == "old body"
        assert data[1]["title"] == "Newer"

    def test_list_versions_empty(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        note.content_versions = None
        mock_session.get.return_value = note

        resp = client.get("/notes/note-1/versions")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_restore_version(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        note.content = "current body"
        note.title = "Current"
        note.content_versions = [
            {"title": "Old", "content": "old body", "created_at": "2026-01-01T00:00:00+00:00"},
        ]
        cat = MagicMock()
        cat.name = "General"
        mock_session.get.side_effect = [note, cat]

        with patch("pkg.api.notes.put_note_markdown_oss", new_callable=AsyncMock, return_value="minio://b/n.md"):
            resp = client.post("/notes/note-1/versions/0/restore")

        assert resp.status_code == 200
        assert note.content == "old body"
        assert note.title == "Old"
        # restore snapshoted the pre-restore state too
        assert note.content_versions is not None
        assert any(v["content"] == "current body" for v in note.content_versions)

    def test_restore_out_of_range(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        note.content_versions = []
        mock_session.get.return_value = note

        resp = client.post("/notes/note-1/versions/5/restore")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# push_content_version helper
# ---------------------------------------------------------------------------
class TestPushContentVersion:
    def test_appends_and_caps(self):
        from pkg.api.notes import NOTE_MAX_VERSIONS, push_content_version

        note = MagicMock(spec=[])
        note.content_versions = None
        note.title = "T"
        note.content = "C"
        push_content_version(note)
        assert len(note.content_versions) == 1
        assert note.content_versions[0]["content"] == "C"

        note.content_versions = [{"title": str(i), "content": str(i), "created_at": "x"} for i in range(NOTE_MAX_VERSIONS)]
        push_content_version(note)
        assert len(note.content_versions) == NOTE_MAX_VERSIONS
        assert note.content_versions[-1]["content"] == "C"


# ---------------------------------------------------------------------------
# POST /notes/{note_id}/images
# ---------------------------------------------------------------------------
class TestUploadNoteImage:
    def _make_upload(self, data=b"png-bytes", content_type="image/png", filename="pic.png"):
        upload = MagicMock()
        upload.read = AsyncMock(return_value=data)
        upload.content_type = content_type
        upload.filename = filename
        return upload

    def test_upload_success(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        category = MagicMock()
        category.name = "General"
        mock_session.get.side_effect = [note, category]

        storage = MagicMock()
        storage.build_object_key.return_value = "notes/General/note-1/pic.png"
        storage.upload_bytes = AsyncMock(return_value="minio://b/notes/General/note-1/pic.png")

        with patch("pkg.api.notes.get_storage_service", return_value=storage):
            resp = client.post("/notes/note-1/images", files={"file": ("pic.png", b"png-bytes", "image/png")})

        assert resp.status_code == 201
        body = resp.json()
        assert body["note_id"] == "note-1"
        assert body["url"] == "/notes/note-1/images/" + body["id"]
        assert body["id"].startswith("img-")
        mock_session.add.assert_called()
        mock_session.commit.assert_awaited()

    def test_rejects_non_image(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        mock_session.get.return_value = note

        resp = client.post("/notes/note-1/images", files={"file": ("doc.pdf", b"x", "application/pdf")})
        assert resp.status_code == 415

    def test_get_image_redirects(self, client, mock_session, fake_user):
        note = _make_note("note-1", fake_user.id)
        image = MagicMock()
        image.id = "img-abc"
        image.note_id = "note-1"
        image.storage_uri = "minio://b/notes/note-1/img-abc.png"
        mock_session.get.side_effect = [note, image]

        storage = MagicMock()
        storage.generate_download_url = AsyncMock(return_value="https://minio/presigned")

        with patch("pkg.api.notes.get_storage_service", return_value=storage):
            resp = client.get("/notes/note-1/images/img-abc", follow_redirects=False)

        assert resp.status_code == 307
        assert resp.headers["location"] == "https://minio/presigned"
