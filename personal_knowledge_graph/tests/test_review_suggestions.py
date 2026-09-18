from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.review import ReviewSuggestion
from pkg.models.user import UserMemory
from pkg.services.foundation.review_suggestions import apply_review_suggestion, ensure_review_suggestions
from pkg.services.cross_cutting.user_profiler import PROFILE_MEMORY_KEY


class _ScalarResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return iter(self._items)

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


@pytest.mark.asyncio
async def test_generates_profile_suggestion_for_missing_interests():
    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(user_id="user-1", key=PROFILE_MEMORY_KEY, value={"behavior": {}, "summary": "short"})
    session.execute.side_effect = [_ScalarResult([profile]), _ScalarResult([])]

    created, skipped = await ensure_review_suggestions(session, user_id="user-1")

    assert created >= 1
    assert skipped == 0
    suggestion = session.add.call_args.args[0]
    assert suggestion.suggestion_type == "profile_update"
    assert suggestion.target_id == PROFILE_MEMORY_KEY
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_apply_profile_suggestion_records_reviewed_suggestion():
    session = AsyncMock()
    profile = UserMemory(user_id="user-1", key=PROFILE_MEMORY_KEY, value={"summary": "Useful profile summary"})
    session.execute.return_value = _ScalarResult([profile])
    suggestion = ReviewSuggestion(
        user_id="user-1",
        suggestion_type="profile_update",
        target_type="user_profile",
        target_id=PROFILE_MEMORY_KEY,
        title="Review profile",
        proposed_value={"field": "interests", "issue": "missing"},
    )

    await apply_review_suggestion(session, suggestion)

    assert profile.value["_reviewed_suggestions"] == [{"field": "interests", "issue": "missing"}]
    assert "_last_profile_suggestion_applied_at" in profile.value
