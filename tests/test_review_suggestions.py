from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.memory import MemoryNode
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
async def test_generates_low_confidence_fact_suggestion():
    session = AsyncMock()
    session.add = MagicMock()
    node = MemoryNode(
        id="mem-low",
        user_id="user-1",
        node_type="fact",
        scope_id="fact-1",
        level="fact",
        title="Possible preference",
        summary="Maybe likes architecture diagrams",
        content="Maybe likes architecture diagrams",
        confidence_score=0.3,
    )
    node.derived_from_notes = []
    node.derived_from_sources = []
    node.derived_from_chunks = []
    node.child_node_ids = []
    node.metadata_ = {}
    session.execute.side_effect = [_ScalarResult([node]), _ScalarResult([])]

    created, skipped = await ensure_review_suggestions(
        session,
        user_id="user-1",
        include_profile_suggestions=False,
    )

    assert created == 1
    assert skipped == 0
    suggestion = session.add.call_args.args[0]
    assert suggestion.suggestion_type == "low_confidence_fact"
    assert suggestion.target_id == "mem-low"
    assert suggestion.evidence["confidence_score"] == 0.3
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_generates_profile_suggestion_for_missing_interests():
    session = AsyncMock()
    session.add = MagicMock()
    profile = UserMemory(user_id="user-1", key=PROFILE_MEMORY_KEY, value={"behavior": {}, "summary": "short"})
    session.execute.side_effect = [_ScalarResult([profile]), _ScalarResult([])]

    created, skipped = await ensure_review_suggestions(
        session,
        user_id="user-1",
        include_low_confidence_facts=False,
    )

    assert created >= 1
    assert skipped == 0
    suggestion = session.add.call_args.args[0]
    assert suggestion.suggestion_type == "profile_update"
    assert suggestion.target_id == PROFILE_MEMORY_KEY
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_apply_low_confidence_fact_confirms_memory():
    session = AsyncMock()
    node = MagicMock(spec=MemoryNode)
    node.user_id = "user-1"
    node.metadata_ = {}
    node.confidence_score = 0.2
    session.get.return_value = node
    suggestion = ReviewSuggestion(
        user_id="user-1",
        suggestion_type="low_confidence_fact",
        target_type="memory_node",
        target_id="mem-low",
        title="Review fact",
    )

    await apply_review_suggestion(session, suggestion)

    assert "status" not in node.metadata_
    assert node.confidence_score == 0.55


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
