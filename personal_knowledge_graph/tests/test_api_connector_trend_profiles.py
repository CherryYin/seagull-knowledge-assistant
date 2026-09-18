from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError


@pytest.mark.asyncio
async def test_list_github_trend_profiles_is_user_scoped(fake_user, mock_session):
    from pkg.api.connectors import list_github_trend_profiles

    rows = MagicMock()
    rows.scalars.return_value = []
    mock_session.execute.return_value = rows

    response = await list_github_trend_profiles(user=fake_user, session=mock_session)

    assert response.model_dump() == {"items": [], "total": 0}
    statement = mock_session.execute.await_args.args[0]
    assert "github_trend_profiles.user_id" in str(statement)


def test_github_trend_profile_schema_rejects_invalid_schedule():
    from pkg.schemas.connector import GitHubTrendProfileCreate

    with pytest.raises(ValidationError):
        GitHubTrendProfileCreate.model_validate({
            "name": "Agents",
            "query": "agent framework",
            "schedule": "hourly",
        })
