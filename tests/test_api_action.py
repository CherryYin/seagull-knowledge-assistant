"""Tests for action API — SSE format validation and helper functions."""

import json

import pytest

from pkg.api.action import (
    _derive_title,
    _extract_document_metadata,
    _make_message_dict,
    _normalize_strands_message,
    _sse,
)


# ---------------------------------------------------------------------------
# _sse helper
# ---------------------------------------------------------------------------
class TestSse:
    def test_dict_payload(self):
        result = _sse("content", {"text": "hello"})
        assert result.startswith("event: content\n")
        assert "data:" in result
        assert result.endswith("\n\n")
        data = json.loads(result.split("data: ", 1)[1].strip())
        assert data["text"] == "hello"

    def test_string_payload(self):
        result = _sse("done", '{"session_id": "s-1"}')
        assert "event: done\n" in result


# ---------------------------------------------------------------------------
# _normalize_strands_message
# ---------------------------------------------------------------------------
class TestNormalizeStrandsMessage:
    def test_string_content(self):
        msg = _normalize_strands_message({"role": "user", "content": "hello"})
        assert msg["role"] == "user"
        assert msg["content"] == [{"text": "hello"}]

    def test_list_content(self):
        msg = _normalize_strands_message({"role": "assistant", "content": [{"text": "hi"}]})
        assert msg["content"] == [{"text": "hi"}]

    def test_none_content(self):
        msg = _normalize_strands_message({"role": "user", "content": None})
        assert msg["content"] == [{"text": ""}]

    def test_string_in_list_content(self):
        msg = _normalize_strands_message({"role": "user", "content": ["hello", "world"]})
        assert msg["content"] == [{"text": "hello"}, {"text": "world"}]


# ---------------------------------------------------------------------------
# _make_message_dict
# ---------------------------------------------------------------------------
class TestMakeMessageDict:
    def test_basic(self):
        msg = _make_message_dict("user", "hello")
        assert msg["role"] == "user"
        assert msg["content"] == "hello"
        assert msg["id"].startswith("msg-")
        assert "created_at" in msg
        assert "metadata" not in msg

    def test_with_metadata(self):
        meta = {"documents": [{"format": "pdf"}]}
        msg = _make_message_dict("assistant", "done", metadata=meta)
        assert msg["metadata"] == meta


# ---------------------------------------------------------------------------
# _derive_title
# ---------------------------------------------------------------------------
class TestDeriveTitle:
    def test_from_user_message(self):
        msgs = [{"role": "user", "content": "How does vector search work?"}]
        assert _derive_title(msgs) == "How does vector search work?"

    def test_truncates_long(self):
        msgs = [{"role": "user", "content": "x" * 100}]
        title = _derive_title(msgs)
        assert len(title) <= 44  # 40 + "..."

    def test_no_user_message(self):
        msgs = [{"role": "assistant", "content": "hi"}]
        assert _derive_title(msgs) == "New Session"

    def test_empty(self):
        assert _derive_title([]) == "New Session"


# ---------------------------------------------------------------------------
# _extract_document_metadata
# ---------------------------------------------------------------------------
class TestExtractDocumentMetadata:
    def test_no_link(self):
        assert _extract_document_metadata("Just plain text") is None

    def test_with_download_link(self):
        text = "下载链接: https://minio.example.com/knowledge-graph/exports/report.docx"
        meta = _extract_document_metadata(text)
        assert meta is not None
        assert len(meta["documents"]) == 1
        assert meta["documents"][0]["format"] == "docx"
        assert meta["documents"][0]["filename"] == "report.docx"

    def test_multiple_links(self):
        text = (
            "下载链接: https://minio/knowledge-graph/exports/a.pdf\n"
            "下载链接: https://minio/knowledge-graph/exports/b.docx"
        )
        meta = _extract_document_metadata(text)
        assert meta is not None
        assert len(meta["documents"]) == 2
