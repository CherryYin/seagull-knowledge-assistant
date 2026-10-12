from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from pkg.api.chat_sessions import create_session, list_sessions, update_session
from pkg.schemas.chat_session import ChatSessionCreate, ChatSessionUpdate, ResearchPlan, ResearchState


def make_user():
    user = MagicMock()
    user.id = "user-1"
    return user


@pytest.mark.asyncio
async def test_create_session_persists_ephemeral_reservation() -> None:
    db = AsyncMock()
    db.add = MagicMock()

    async def refresh(obj):
        obj.created_at = datetime(2026, 9, 9, tzinfo=UTC)
        obj.updated_at = datetime(2026, 9, 9, tzinfo=UTC)

    db.refresh = AsyncMock(side_effect=refresh)

    result = await create_session(
        body=ChatSessionCreate(id="session-workflow", is_ephemeral=True),
        user=make_user(),
        db=db,
    )

    assert result.id == "session-workflow"
    assert result.is_ephemeral is True
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_research_state_is_created_and_updated_without_changing_other_users() -> None:
    db = AsyncMock()
    db.add = MagicMock()
    db.refresh = AsyncMock()
    created = await create_session(
        body=ChatSessionCreate(
            id="research-session",
            research_state=ResearchState(question="Which database fits?", status="prepared"),
        ),
        user=make_user(),
        db=db,
    )
    assert created.research_state == {"question": "Which database fits?", "status": "prepared", "asset_id": None, "plan": None}

    db.get = AsyncMock(return_value=created)
    updated = await update_session(
        session_id="research-session",
        body=ChatSessionUpdate(research_state=ResearchState(question="Which database fits?", status="awaiting_review", asset_id="asset-1")),
        user=make_user(),
        db=db,
    )
    assert updated.research_state["asset_id"] == "asset-1"
    foreign = MagicMock()
    foreign.id = "user-2"
    with pytest.raises(HTTPException) as error:
        await update_session(session_id="research-session", body=ChatSessionUpdate(title="Overwrite"), user=foreign, db=db)
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_research_plan_serializes_public_search_previews() -> None:
    db = AsyncMock()
    db.add = MagicMock()
    db.refresh = AsyncMock()
    session = await create_session(
        body=ChatSessionCreate(id="research-preview", research_state=ResearchState(
            question="Compare databases",
            status="prepared",
            plan=ResearchPlan.model_validate({
                "mode": "support_decision", "comparison_dimensions": ["Latency"],
                "approved_web_query": "public database benchmark",
                "web_results": [{"title": "Lead", "url": "https://example.com/lead", "retrieved_at": "2026-09-28T00:00:00Z"}],
            }),
        )),
        user=make_user(),
        db=db,
    )
    assert session.research_state["plan"]["web_results"][0]["url"] == "https://example.com/lead"
    assert session.research_state["plan"]["web_results"][0]["retrieved_at"] == "2026-09-28T00:00:00Z"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("include_ephemeral", "expects_filter"),
    [(False, True), (True, False)],
)
async def test_list_sessions_controls_ephemeral_visibility(
    include_ephemeral: bool,
    expects_filter: bool,
) -> None:
    count_result = MagicMock()
    count_result.scalar.return_value = 0
    rows_result = MagicMock()
    rows_result.scalars.return_value = []
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[count_result, rows_result])

    result = await list_sessions(
        limit=50,
        offset=0,
        include_ephemeral=include_ephemeral,
        user=make_user(),
        db=db,
    )

    assert result.total == 0
    count_statement = str(db.execute.call_args_list[0].args[0])
    assert ("chat_sessions.is_ephemeral IS false" in count_statement) is expects_filter
