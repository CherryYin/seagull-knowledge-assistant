from unittest.mock import MagicMock

from pkg.schemas.note import SearchResult
from pkg.services.foundation.retriever import RetrieverAgent


def test_adjacent_video_search_hits_are_merged():
    retriever = RetrieverAgent(MagicMock(), user_id="user-1")
    results = retriever._merge_adjacent_video_segments(
        [
            SearchResult(
                id="video-1",
                segment_id=1,
                title="Demo",
                type="video_segment",
                score=0.9,
                start_ms=0,
                end_ms=10_000,
                content_preview="opening",
            ),
            SearchResult(
                id="video-1",
                segment_id=2,
                title="Demo",
                type="video_segment",
                score=0.8,
                start_ms=12_000,
                end_ms=20_000,
                content_preview="continued",
            ),
        ],
        top_k=5,
    )

    assert len(results) == 1
    assert results[0].start_ms == 0
    assert results[0].end_ms == 20_000
    assert results[0].content_preview == "opening continued"
