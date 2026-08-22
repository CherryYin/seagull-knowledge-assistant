"""Tests for Pydantic schemas — validation of inputs."""

import pytest
from pydantic import ValidationError

from pkg.schemas.source import SourceCreate, ChunkRead
from pkg.schemas.note import NoteCreate, NoteUpdate, SearchRequest
from pkg.schemas.completion import CompleteRequest
from pkg.schemas.chat_session import ChatSessionCreate, ChatMessageSchema


# ---------------------------------------------------------------------------
# SourceCreate
# ---------------------------------------------------------------------------
class TestSourceCreate:
    def test_valid_minimal(self):
        s = SourceCreate(title="Test Source", source_type="pdf")
        assert s.title == "Test Source"
        assert s.category_id == 1  # default

    def test_valid_all_fields(self):
        s = SourceCreate(
            title="Full Source",
            category_id=2,
            source_type="article",
            url="https://example.com",
            raw_content="Some content",
        )
        assert s.source_type == "article"

    def test_invalid_source_type(self):
        with pytest.raises(ValidationError):
            SourceCreate(title="Bad", source_type="invalid_type")

    def test_all_valid_source_types(self):
        for st in ("pdf", "article", "conversation", "video", "web", "github", "code"):
            s = SourceCreate(title="t", source_type=st)
            assert s.source_type == st


# ---------------------------------------------------------------------------
# NoteCreate
# ---------------------------------------------------------------------------
class TestNoteCreate:
    def test_valid_minimal(self):
        n = NoteCreate(title="Test Note")
        assert n.note_type == "inbox"  # default
        assert n.domains == []
        assert n.tags == []

    def test_valid_full(self):
        n = NoteCreate(
            title="Full",
            note_type="concept",
            domains=["AI"],
            tags=["test"],
            abstract="Summary",
            content="Body",
        )
        assert n.note_type == "concept"

    def test_invalid_note_type(self):
        with pytest.raises(ValidationError):
            NoteCreate(title="Bad", note_type="invalid")

    def test_all_valid_note_types(self):
        for nt in ("architecture", "case-study", "concept", "how-to", "inbox"):
            n = NoteCreate(title="t", note_type=nt)
            assert n.note_type == nt


# ---------------------------------------------------------------------------
# NoteUpdate (partial)
# ---------------------------------------------------------------------------
class TestNoteUpdate:
    def test_empty_update(self):
        u = NoteUpdate()
        assert u.title is None
        assert u.domains is None

    def test_partial_update(self):
        u = NoteUpdate(title="New Title", tags=["new"])
        assert u.title == "New Title"
        assert u.note_type is None  # Not set

    def test_invalid_note_type(self):
        with pytest.raises(ValidationError):
            NoteUpdate(note_type="bad")


# ---------------------------------------------------------------------------
# SearchRequest
# ---------------------------------------------------------------------------
class TestSearchRequest:
    def test_defaults(self):
        r = SearchRequest(query="test")
        assert r.mode == "auto"
        assert r.top_k == 5

    def test_valid_modes(self):
        for mode in ("auto", "sql", "vector", "hybrid"):
            r = SearchRequest(query="q", mode=mode)
            assert r.mode == mode

    def test_invalid_mode(self):
        with pytest.raises(ValidationError):
            SearchRequest(query="q", mode="invalid")

    def test_top_k_bounds(self):
        with pytest.raises(ValidationError):
            SearchRequest(query="q", top_k=0)
        with pytest.raises(ValidationError):
            SearchRequest(query="q", top_k=51)
        r = SearchRequest(query="q", top_k=50)
        assert r.top_k == 50


# ---------------------------------------------------------------------------
# CompleteRequest
# ---------------------------------------------------------------------------
class TestCompletionSchemas:
    def test_complete_request(self):
        request = CompleteRequest(messages=[{"role": "user", "content": "hello"}])
        assert request.messages[0].role == "user"
        assert request.temperature is None


# ---------------------------------------------------------------------------
# ChatSession schemas
# ---------------------------------------------------------------------------
class TestChatSessionSchemas:
    def test_message_schema(self):
        m = ChatMessageSchema(
            id="msg-1", role="user", content="hello", created_at="2026-01-01T00:00:00Z"
        )
        assert m.role == "user"

    def test_session_create_defaults(self):
        s = ChatSessionCreate()
        assert s.title == "New Session"
        assert s.messages == []

    def test_session_create_with_messages(self):
        msg = ChatMessageSchema(
            id="msg-1", role="user", content="hi", created_at="2026-01-01T00:00:00Z"
        )
        s = ChatSessionCreate(title="My Chat", messages=[msg])
        assert len(s.messages) == 1
