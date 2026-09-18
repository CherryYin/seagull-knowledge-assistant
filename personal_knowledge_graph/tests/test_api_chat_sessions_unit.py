from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.api.chat_sessions import create_session, list_sessions
from pkg.schemas.chat_session import ChatSessionCreate


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
