from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from pkg.services.foundation.paper_discovery_jobs import run_scheduled_paper_discovery_profiles, should_run_profile


def make_profile(**overrides):
    base = {
        "id": 1,
        "user_id": "user-1",
        "is_enabled": True,
        "schedule": "daily",
        "last_run_at": None,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_should_run_profile_daily_when_never_run():
    assert should_run_profile(make_profile(schedule="daily", last_run_at=None)) is True


def test_should_run_profile_weekly_respects_interval():
    now = datetime(2026, 6, 4, tzinfo=timezone.utc)
    profile = make_profile(schedule="weekly", last_run_at=now - timedelta(days=3))

    assert should_run_profile(profile, now=now) is False
    assert should_run_profile(make_profile(schedule="weekly", last_run_at=now - timedelta(days=8)), now=now) is True


@pytest.mark.asyncio
async def test_run_scheduled_paper_discovery_profiles_executes_eligible_profiles(monkeypatch):
    daily = make_profile(id=1, schedule="daily", last_run_at=None)
    manual = make_profile(id=2, schedule="manual", last_run_at=None)

    class FakeSession:
        async def execute(self, _query):
            return SimpleNamespace(scalars=lambda: [daily, manual])

        async def commit(self):
            return None

    calls = []

    async def fake_execute_profile_run(session, *, user_id, profile_id, mode, commit):
        calls.append((user_id, profile_id, mode, commit))
        return SimpleNamespace(id=1), [], 2, 1

    monkeypatch.setattr("pkg.services.foundation.paper_discovery_jobs.execute_profile_run", fake_execute_profile_run)

    stats = await run_scheduled_paper_discovery_profiles(FakeSession())

    assert stats["profiles"] == 2
    assert stats["eligible"] == 1
    assert stats["runs"] == 1
    assert stats["created"] == 2
    assert stats["updated"] == 1
    assert stats["errors"] == 0
    assert calls == [("user-1", 1, "query", False)]


@pytest.mark.asyncio
async def test_run_scheduled_paper_discovery_profiles_continues_after_profile_failure(monkeypatch):
    failed = make_profile(id=1, user_id="user-1")
    healthy = make_profile(id=2, user_id="user-2")

    class FakeSession:
        def __init__(self):
            self.commits = 0
            self.rollbacks = 0

        async def execute(self, _query):
            return SimpleNamespace(scalars=lambda: [failed, healthy])

        async def commit(self):
            self.commits += 1

        async def rollback(self):
            self.rollbacks += 1

    async def fake_execute_profile_run(session, *, profile_id, **_kwargs):
        if profile_id == 1:
            raise RuntimeError("provider failed")
        return SimpleNamespace(id=2), [], 3, 1

    monkeypatch.setattr(
        "pkg.services.foundation.paper_discovery_jobs.execute_profile_run",
        fake_execute_profile_run,
    )
    session = FakeSession()

    stats = await run_scheduled_paper_discovery_profiles(session)

    assert stats == {
        "profiles": 2,
        "eligible": 2,
        "runs": 1,
        "created": 3,
        "updated": 1,
        "errors": 1,
    }
    assert session.commits == 1
    assert session.rollbacks == 1
