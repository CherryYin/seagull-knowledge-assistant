from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
import httpx
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from pkg.api.paper_discovery import (
    create_paper_discovery_profile,
    list_paper_discovery_candidates,
    list_paper_discovery_profiles,
    list_paper_discovery_runs,
    preview_paper_discovery_profile,
    run_paper_discovery_profile,
    update_paper_discovery_profile,
)
from pkg.schemas.paper_discovery import (
    PaperDiscoveryExecuteRequest,
    PaperDiscoveryPreviewRequest,
    PaperDiscoveryProfileCreate,
    PaperDiscoveryProfileUpdate,
)


def _make_profile(profile_id: int, user_id: str):
    return SimpleNamespace(
        id=profile_id,
        user_id=user_id,
        name="Agents Radar",
        description="desc",
        goal_prompt="agent memory",
        mode="query",
        provider="semantic_scholar",
        is_enabled=True,
        max_results=20,
        time_window_days=30,
        include_terms=["agent memory"],
        exclude_terms=["robotics"],
        preferred_authors=[],
        preferred_venues=[],
        preferred_fields=[],
        preferred_arxiv_categories=[],
        seed_paper_ids=[],
        last_run_at=None,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


class _ScalarResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return self

    def __iter__(self):
        return iter(self._items)


@pytest.mark.asyncio
async def test_list_profiles(mock_session, fake_user):
    mock_session.execute.return_value = _ScalarResult([_make_profile(1, fake_user.id)])

    result = await list_paper_discovery_profiles(user=fake_user, session=mock_session)

    assert result.total == 1
    assert result.items[0].name == "Agents Radar"


@pytest.mark.asyncio
async def test_create_profile(mock_session, fake_user):
    async def fake_refresh(item):
        item.id = 1
        item.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        item.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

    mock_session.refresh.side_effect = fake_refresh

    result = await create_paper_discovery_profile(
        PaperDiscoveryProfileCreate(name="Agents Radar", goal_prompt="agent memory"),
        user=fake_user,
        session=mock_session,
    )

    assert result.name == "Agents Radar"
    mock_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_create_profile_returns_409_on_duplicate_name(mock_session, fake_user):
    mock_session.commit.side_effect = IntegrityError("stmt", "params", Exception("duplicate"))

    with pytest.raises(HTTPException) as exc_info:
        await create_paper_discovery_profile(
            PaperDiscoveryProfileCreate(name="Agents Radar", goal_prompt="agent memory"),
            user=fake_user,
            session=mock_session,
        )

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_update_profile_not_found(mock_session, fake_user):
    mock_session.execute.return_value = SimpleNamespace(scalar_one_or_none=lambda: None)

    with pytest.raises(HTTPException) as exc_info:
        await update_paper_discovery_profile(
            1,
            PaperDiscoveryProfileUpdate(name="Updated"),
            user=fake_user,
            session=mock_session,
        )

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_preview_profile(mock_session, fake_user, monkeypatch):
    async def fake_preview_profile_queries(session, *, user_id, profile_id):
        return {
            "profile_name": "Agents Radar",
            "mode": "query",
            "provider": "semantic_scholar",
            "primary_queries": [{"label": "primary", "query": "agent memory", "provider": "semantic_scholar", "filters": {}}],
            "expanded_queries": [],
            "trend_queries": [],
            "negative_terms": [],
            "author_filters": [],
            "field_filters": [],
            "venue_filters": [],
            "date_filters": {},
        }

    monkeypatch.setattr("pkg.api.paper_discovery.preview_profile_queries", fake_preview_profile_queries)

    result = await preview_paper_discovery_profile(
        1,
        PaperDiscoveryPreviewRequest(),
        user=fake_user,
        session=mock_session,
    )

    assert result["primary_queries"][0]["query"] == "agent memory"


@pytest.mark.asyncio
async def test_run_profile(mock_session, fake_user, monkeypatch):
    async def fake_execute_profile_run(session, *, user_id, profile_id, mode, limit):
        run = SimpleNamespace(
            id=11,
            profile_id=profile_id,
            user_id=user_id,
            mode=mode or "query",
            status="completed",
            query_bundle={"profile_name": "Agents Radar"},
            stats={"created": 1},
            error=None,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            finished_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        return run, [], 1, 0

    monkeypatch.setattr("pkg.api.paper_discovery.execute_profile_run", fake_execute_profile_run)

    result = await run_paper_discovery_profile(
        1,
        PaperDiscoveryExecuteRequest(),
        user=fake_user,
        session=mock_session,
    )

    assert result.status == "completed"


@pytest.mark.asyncio
async def test_run_profile_returns_500_when_provider_times_out(mock_session, fake_user, monkeypatch):
    async def fake_execute_profile_run(session, *, user_id, profile_id, mode, limit):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr("pkg.api.paper_discovery.execute_profile_run", fake_execute_profile_run)

    with pytest.raises(HTTPException) as exc_info:
        await run_paper_discovery_profile(
            1,
            PaperDiscoveryExecuteRequest(),
            user=fake_user,
            session=mock_session,
        )

    assert exc_info.value.status_code == 500


@pytest.mark.asyncio
async def test_run_profile_returns_provider_error_detail_and_rolls_back(mock_session, fake_user, monkeypatch):
    async def fake_execute_profile_run(session, *, user_id, profile_id, mode, limit):
        raise AttributeError("'Settings' object has no attribute 'OPENALEX_POLITE_EMAIL'")

    monkeypatch.setattr("pkg.api.paper_discovery.execute_profile_run", fake_execute_profile_run)

    with pytest.raises(HTTPException) as exc_info:
        await run_paper_discovery_profile(
            1,
            PaperDiscoveryExecuteRequest(),
            user=fake_user,
            session=mock_session,
        )

    assert exc_info.value.status_code == 500
    assert "OPENALEX_POLITE_EMAIL" in exc_info.value.detail
    mock_session.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_list_runs(mock_session, fake_user, monkeypatch):
    profile = _make_profile(1, fake_user.id)
    run = SimpleNamespace(
        id=11,
        profile_id=1,
        user_id=fake_user.id,
        mode="query",
        status="completed",
        query_bundle={},
        stats={},
        error=None,
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        finished_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    mock_session.execute.side_effect = [
        SimpleNamespace(scalar_one_or_none=lambda: profile),
        _ScalarResult([run]),
    ]

    result = await list_paper_discovery_runs(1, user=fake_user, session=mock_session)

    assert result.total == 1


@pytest.mark.asyncio
async def test_list_candidates(mock_session, fake_user, monkeypatch):
    item = SimpleNamespace(
        id=1,
        user_id=fake_user.id,
        provider="semantic_scholar",
        item_key="semantic_scholar:arxiv:2501.12345",
        title="Agent Memory Systems",
        url="https://example.org/p1",
        summary="summary",
        payload={"origin": "paper_discovery", "paper_profile_id": 1},
        status="recommended",
        score=12.0,
        why=["Matches profile interests"],
        source_id=None,
        feedback=None,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        reviewed_at=None,
    )

    async def fake_list_profile_candidates(session, *, user_id, profile_id, limit):
        return [item]

    monkeypatch.setattr("pkg.api.paper_discovery.list_profile_candidates", fake_list_profile_candidates)

    result = await list_paper_discovery_candidates(1, user=fake_user, session=mock_session)

    assert result.total == 1
    assert result.items[0].title == "Agent Memory Systems"
