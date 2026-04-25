"""Shared test fixtures for the personal knowledge graph backend."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fake user (MagicMock to avoid SQLAlchemy instrumented attribute issues)
# ---------------------------------------------------------------------------
@pytest.fixture
def fake_user():
    user = MagicMock()
    user.id = "test-user-001"
    user.username = "testuser"
    user.display_name = "Test User"
    user.email = "test@example.com"
    user.hashed_password = ""
    user.role = "user"
    user.is_active = True
    user.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    user.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return user


@pytest.fixture
def fake_admin():
    user = MagicMock()
    user.id = "admin-001"
    user.username = "admin"
    user.display_name = "Admin"
    user.email = "admin@example.com"
    user.hashed_password = ""
    user.role = "admin"
    user.is_active = True
    user.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    user.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return user


# ---------------------------------------------------------------------------
# Mock async DB session
# ---------------------------------------------------------------------------
@pytest.fixture
def mock_session():
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.execute = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.delete = AsyncMock()
    return session


# ---------------------------------------------------------------------------
# FastAPI test client with dependency overrides
# ---------------------------------------------------------------------------
@pytest.fixture
def client(fake_user, mock_session):
    # Defer import to avoid module-level side effects
    from pkg.api.app import app
    from pkg.api.deps import get_current_user
    from pkg.db import get_session

    async def override_get_session():
        yield mock_session

    async def override_get_current_user():
        return fake_user

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = override_get_current_user

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()
