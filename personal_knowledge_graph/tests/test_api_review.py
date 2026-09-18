from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_dismiss_review_suggestion_keeps_distinct_status():
    from pkg.api.review import update_review_suggestion
    from pkg.models.review import ReviewSuggestion
    from pkg.schemas.review import ReviewSuggestionUpdate

    fake_user = MagicMock()
    fake_user.id = "user-1"

    suggestion = ReviewSuggestion(
        id=1,
        user_id=fake_user.id,
        suggestion_type="profile_update",
        target_type="user_profile",
        target_id="user_profile",
        title="Profile quality suggestion",
        summary="Needs review",
        proposed_value=None,
        evidence=None,
        status="pending",
        metadata_={},
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    session = MagicMock()
    session.get = AsyncMock(return_value=suggestion)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()

    result = await update_review_suggestion(
        1,
        ReviewSuggestionUpdate(status="dismissed"),
        user=fake_user,
        session=session,
    )

    assert result.status == "dismissed"
    assert result.reviewed_at is not None
    assert result.applied_at is None
    session.commit.assert_awaited_once()
