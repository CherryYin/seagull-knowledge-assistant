"""Tests for pkg.services.chunking — markdown-aware text chunking."""

import pytest

from pkg.services.chunking import (
    _count_tokens,
    _split_blocks,
    _split_sections,
    chunk_text,
)


# ---------------------------------------------------------------------------
# _count_tokens
# ---------------------------------------------------------------------------
class TestCountTokens:
    def test_empty(self):
        assert _count_tokens("") == 0

    def test_english(self):
        tokens = _count_tokens("Hello world")
        assert tokens >= 2

    def test_chinese(self):
        tokens = _count_tokens("你好世界")
        assert tokens >= 2


# ---------------------------------------------------------------------------
# _split_sections
# ---------------------------------------------------------------------------
class TestSplitSections:
    def test_no_headings(self):
        sections = _split_sections("Just plain text.")
        assert len(sections) == 1
        assert sections[0][0] == ""  # no heading
        assert "plain text" in sections[0][1]

    def test_single_heading(self):
        text = "# Title\nSome body text."
        sections = _split_sections(text)
        assert len(sections) == 1
        assert sections[0][0] == "# Title"
        assert "body text" in sections[0][1]

    def test_multiple_headings(self):
        text = "# First\nBody1\n## Second\nBody2\n### Third\nBody3"
        sections = _split_sections(text)
        assert len(sections) == 3
        assert sections[0][0] == "# First"
        assert sections[1][0] == "## Second"
        assert sections[2][0] == "### Third"

    def test_content_before_first_heading(self):
        text = "Intro text\n\n# Heading\nBody"
        sections = _split_sections(text)
        assert len(sections) == 2
        assert sections[0][0] == ""
        assert "Intro" in sections[0][1]
        assert sections[1][0] == "# Heading"


# ---------------------------------------------------------------------------
# _split_blocks
# ---------------------------------------------------------------------------
class TestSplitBlocks:
    def test_paragraphs(self):
        body = "Paragraph one.\n\nParagraph two.\n\nParagraph three."
        blocks = _split_blocks(body)
        assert len(blocks) == 3

    def test_table_kept_together(self):
        body = (
            "Some text.\n\n"
            "| Col1 | Col2 |\n"
            "|------|------|\n"
            "| A    | B    |\n"
            "| C    | D    |"
        )
        blocks = _split_blocks(body)
        # Text + one table block
        assert len(blocks) == 2
        assert "|" in blocks[1]
        assert blocks[1].count("\n") >= 3  # All table rows in one block

    def test_empty_body(self):
        assert _split_blocks("") == []
        assert _split_blocks("   ") == []


# ---------------------------------------------------------------------------
# chunk_text (integration)
# ---------------------------------------------------------------------------
class TestChunkText:
    def test_empty_input(self):
        assert chunk_text("") == []
        assert chunk_text("   \n  ") == []

    def test_short_text_returns_empty(self):
        # Text that fits in one chunk should return empty
        assert chunk_text("Hello world", max_tokens=100) == []

    def test_sections_split_correctly(self):
        text = "# Section A\n\n" + ("word " * 500) + "\n\n# Section B\n\n" + ("word " * 500)
        chunks = chunk_text(text, max_tokens=200)
        assert len(chunks) >= 2

    def test_table_not_split(self):
        table = "| A | B |\n|---|---|\n" + "\n".join(f"| {i} | {i} |" for i in range(50))
        text = "# Data\n\n" + table + "\n\n# Analysis\n\n" + ("word " * 500)
        chunks = chunk_text(text, max_tokens=300)
        # Find the chunk containing the table
        table_chunks = [c for c in chunks if "|" in c and "---" in c]
        assert len(table_chunks) >= 1
        # Table should be intact (all rows in same chunk)
        for tc in table_chunks:
            row_count = sum(1 for line in tc.split("\n") if line.strip().startswith("|"))
            assert row_count >= 50  # All rows present

    def test_heading_preserved_in_subchunks(self):
        # A long section that must be sub-split should carry the heading
        text = "## My Heading\n\n" + "\n\n".join(f"Paragraph {i}. " + "word " * 100 for i in range(20))
        chunks = chunk_text(text, max_tokens=200)
        assert len(chunks) >= 2
        # All sub-chunks of this section should start with the heading
        for c in chunks:
            assert c.startswith("## My Heading")

    def test_small_sections_merged(self):
        # Many small sections should be merged into fewer chunks
        text = "\n\n".join(f"## Section {i}\n\nShort body." for i in range(20))
        chunks = chunk_text(text, max_tokens=500)
        # 20 tiny sections should merge into much fewer chunks
        assert len(chunks) < 20

    def test_max_tokens_respected(self):
        text = "# Title\n\n" + "\n\n".join(f"Paragraph {i}. " + "long " * 200 for i in range(10))
        chunks = chunk_text(text, max_tokens=300)
        for c in chunks:
            assert _count_tokens(c) <= 600  # Allow some slack for heading prefix

    def test_plain_text_no_headings(self):
        # Long text without headings should still be chunked
        text = "\n\n".join(f"Paragraph {i}. " + "word " * 100 for i in range(20))
        chunks = chunk_text(text, max_tokens=200)
        assert len(chunks) >= 2
