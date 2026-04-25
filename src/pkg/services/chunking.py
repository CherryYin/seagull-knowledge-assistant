"""Markdown-aware chunking: split by sections, preserve tables, respect token limits."""

import re

import tiktoken

from pkg.config import settings

_enc = tiktoken.encoding_for_model("gpt-4o")

_HEADING_RE = re.compile(r"^(#{1,6})\s+", re.MULTILINE)
_TABLE_ROW_RE = re.compile(r"^\s*\|.+\|", re.MULTILINE)


def _count_tokens(text: str) -> int:
    return len(_enc.encode(text))


def _split_sections(text: str) -> list[tuple[str, str]]:
    """Split text by markdown headings.

    Returns a list of (heading, body) tuples.  The first element may have an
    empty heading if the document starts without one.
    """
    parts: list[tuple[str, str]] = []
    positions = [m.start() for m in _HEADING_RE.finditer(text)]

    if not positions:
        return [("", text)]

    # Content before the first heading
    if positions[0] > 0:
        parts.append(("", text[: positions[0]].strip()))

    for i, pos in enumerate(positions):
        end = positions[i + 1] if i + 1 < len(positions) else len(text)
        section = text[pos:end]
        # Separate heading line from body
        newline = section.find("\n")
        if newline == -1:
            parts.append((section.strip(), ""))
        else:
            parts.append((section[:newline].strip(), section[newline + 1 :].strip()))

    return parts


def _split_blocks(body: str) -> list[str]:
    """Split section body into paragraphs while keeping table blocks intact.

    Consecutive lines starting with ``|`` are grouped as a single block.
    """
    blocks: list[str] = []
    current_table_lines: list[str] = []

    for para in re.split(r"\n{2,}", body):
        para = para.strip()
        if not para:
            continue

        lines = para.split("\n")
        is_table = all(_TABLE_ROW_RE.match(line) for line in lines)

        if is_table:
            current_table_lines.extend(lines)
        else:
            # Flush any accumulated table
            if current_table_lines:
                blocks.append("\n".join(current_table_lines))
                current_table_lines = []
            blocks.append(para)

    if current_table_lines:
        blocks.append("\n".join(current_table_lines))

    return blocks


def chunk_text(text: str, max_tokens: int | None = None) -> list[str]:
    """Split *text* into markdown-aware chunks.

    Rules:
    1. Split by markdown headings (``# …``, ``## …``, etc.)
    2. Tables (``| … |`` rows) are never split.
    3. Each chunk is at most *max_tokens* tokens (tiktoken gpt-4o encoding).
    4. If a section exceeds the limit, it is sub-split by paragraphs; each
       sub-chunk is prefixed with the section heading for context.
    5. Returns empty list when the whole text fits in one chunk.
    """
    if not text or not text.strip():
        return []

    limit = max_tokens or settings.CHUNK_MAX_TOKENS

    # If entire text fits in one chunk, return empty (caller uses doc-level embedding)
    if _count_tokens(text) <= limit:
        return []

    sections = _split_sections(text)

    # Phase 1: expand each section — small sections stay as-is, large ones get sub-split
    pieces: list[str] = []
    for heading, body in sections:
        section_text = f"{heading}\n\n{body}".strip() if heading else body.strip()
        if not section_text:
            continue

        if _count_tokens(section_text) <= limit:
            pieces.append(section_text)
            continue

        # Section too large — split by blocks (paragraphs / tables)
        blocks = _split_blocks(body)
        if not blocks:
            pieces.append(section_text)
            continue

        current_parts: list[str] = []
        current_tokens = _count_tokens(heading) if heading else 0

        for block in blocks:
            block_tokens = _count_tokens(block)

            if current_parts and current_tokens + block_tokens > limit:
                chunk = f"{heading}\n\n" + "\n\n".join(current_parts) if heading else "\n\n".join(current_parts)
                pieces.append(chunk.strip())
                current_parts = []
                current_tokens = _count_tokens(heading) if heading else 0

            current_parts.append(block)
            current_tokens += block_tokens

        if current_parts:
            chunk = f"{heading}\n\n" + "\n\n".join(current_parts) if heading else "\n\n".join(current_parts)
            pieces.append(chunk.strip())

    # Phase 2: greedily merge adjacent small pieces into chunks up to the limit
    chunks: list[str] = []
    buf: list[str] = []
    buf_tokens = 0

    for piece in pieces:
        piece_tokens = _count_tokens(piece)
        if buf and buf_tokens + piece_tokens > limit:
            chunks.append("\n\n".join(buf))
            buf = []
            buf_tokens = 0
        buf.append(piece)
        buf_tokens += piece_tokens

    if buf:
        chunks.append("\n\n".join(buf))

    return chunks
