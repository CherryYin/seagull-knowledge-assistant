from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.schemas.library import LibrarySearchRequest, LibrarySearchResponse
from pkg.services.foundation.library import LibraryService


@pytest.mark.asyncio
async def test_library_route_uses_unified_contract_and_logs_activity():
    from pkg.api.library import search_library

    fake_user = MagicMock()
    fake_user.id = "user-1"
    response = LibrarySearchResponse(items=[], total=0, limit=20, offset=0)
    service = MagicMock()
    service.search = AsyncMock(return_value=response)

    with (
        patch("pkg.api.library.LibraryService", return_value=service),
        patch("pkg.api.library.log_activity", new=AsyncMock()) as log_activity,
    ):
        result = await search_library(
            LibrarySearchRequest(query="retrieval", media_types=["video"]),
            user=fake_user,
            session=AsyncMock(),
        )

    assert result == response
    service.search.assert_awaited_once()
    log_activity.assert_awaited_once()


def test_library_filters_keep_domain_lifecycle_independent():
    from pkg.schemas.library import LibrarySearchHit, LibrarySearchResult

    service = LibraryService(MagicMock(), "user-1")
    item = LibrarySearchResult(
        id="note-1",
        entity_type="note",
        result_type="note",
        title="Retrieval notes",
        excerpt="Notes about hybrid retrieval",
        score=0.9,
        href="/notes/note-1",
        created_at=datetime(2026, 9, 1),
        updated_at=datetime(2026, 9, 10),
        tags=["retrieval", "architecture"],
        lifecycle_status="growing",
        hit=LibrarySearchHit(field="summary", reason="Matched this Note."),
    )

    assert service._matches(
        item,
        LibrarySearchRequest(
            entity_types=["note"],
            lifecycle_statuses=["growing"],
            tags=["retrieval"],
            date_from=datetime(2026, 9, 5),
        ),
    )
    assert not service._matches(
        item,
        LibrarySearchRequest(media_types=["text"]),
    )


def test_library_facets_separate_entity_and_media_types():
    from pkg.schemas.library import LibrarySearchHit, LibrarySearchResult

    service = LibraryService(MagicMock(), "user-1")
    items = [
        LibrarySearchResult(
            id="source-1",
            entity_type="source",
            result_type="source",
            media_type="image",
            title="Diagram",
            score=1,
            href="/sources/source-1",
            lifecycle_status="active",
            hit=LibrarySearchHit(field="caption", reason="Matched caption."),
        ),
        LibrarySearchResult(
            id="wiki-1",
            entity_type="wiki",
            result_type="wiki",
            title="Architecture",
            score=1,
            href="/wiki/wiki-1",
            lifecycle_status="stable",
            hit=LibrarySearchHit(field="summary", reason="Matched Wiki."),
        ),
    ]

    facets = service._facets(items)

    assert facets["entity_type"] == {"source": 1, "wiki": 1}
    assert facets["media_type"] == {"image": 1}
    assert facets["lifecycle_status"] == {"active": 1, "stable": 1}


def test_library_date_filter_accepts_timezone_aware_boundaries():
    from datetime import timezone

    from pkg.schemas.library import LibrarySearchHit, LibrarySearchResult

    service = LibraryService(MagicMock(), "user-1")
    item = LibrarySearchResult(
        id="wiki-1",
        entity_type="wiki",
        result_type="wiki",
        title="Architecture",
        score=1,
        href="/wiki/wiki-1",
        updated_at=datetime(2026, 9, 10),
        hit=LibrarySearchHit(field="summary", reason="Matched Wiki."),
    )

    assert service._matches(
        item,
        LibrarySearchRequest(date_from=datetime(2026, 9, 1, tzinfo=timezone.utc)),
    )
