"""Split text into overlapping chunks for fine-grained embedding."""

from pkg.config import settings


def chunk_text(
    text: str,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
) -> list[str]:
    """Split *text* into overlapping chunks.

    Returns an empty list when the text is short enough to fit in a single
    chunk (callers should fall back to the whole-document embedding).

    Args:
        text: The source text to chunk.
        chunk_size: Target chunk size in characters (default from settings).
        chunk_overlap: Overlap between consecutive chunks (default from settings).
    """
    size = chunk_size or settings.CHUNK_SIZE
    overlap = chunk_overlap or settings.CHUNK_OVERLAP

    if not text or len(text) <= size:
        return []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + size
        chunks.append(text[start:end])
        start += size - overlap

    return chunks
