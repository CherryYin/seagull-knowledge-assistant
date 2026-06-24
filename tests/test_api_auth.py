"""Tests for auth API endpoints (/auth/*)."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from pkg.services.cross_cutting.auth import hash_password


@pytest.fixture
def auth_client(fake_user, fake_admin, mock_session):
    """Client with login-capable user fixtures and admin overrides."""
    from pkg.api.app import app
    from pkg.api.deps import get_current_user, get_admin_user
    from pkg.db import get_session

    # Give the fake user a real hashed password for login tests
    fake_user.hashed_password = hash_password("correct-password")

    async def override_get_session():
        yield mock_session

    async def override_get_current_user():
        return fake_user

    async def override_get_admin_user():
        return fake_admin

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_admin_user] = override_get_admin_user

    client = TestClient(app, raise_server_exceptions=False)
    try:
        yield client
    finally:
        client.close()
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------
class TestLogin:
    def test_success(self, auth_client, mock_session, fake_user):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = fake_user
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/login", json={"username": "testuser", "password": "correct-password"})
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_wrong_password(self, auth_client, mock_session, fake_user):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = fake_user
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/login", json={"username": "testuser", "password": "wrong"})
        assert resp.status_code == 401

    def test_user_not_found(self, auth_client, mock_session):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/login", json={"username": "nobody", "password": "x"})
        assert resp.status_code == 401

    def test_inactive_user(self, auth_client, mock_session, fake_user):
        fake_user.is_active = False
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = fake_user
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/login", json={"username": "testuser", "password": "correct-password"})
        assert resp.status_code == 403
        fake_user.is_active = True  # restore

    def test_pending_user_cannot_login(self, auth_client, mock_session, fake_user):
        fake_user.approval_status = "pending"
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = fake_user
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/login", json={"username": "testuser", "password": "correct-password"})
        assert resp.status_code == 403
        assert "pending" in resp.json()["detail"]
        fake_user.approval_status = "approved"


# ---------------------------------------------------------------------------
# POST /auth/register
# ---------------------------------------------------------------------------
class TestRegister:
    def test_register_creates_pending_user(self, auth_client, mock_session):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/register", json={
            "username": "newuser",
            "display_name": "New User",
            "email": "new@example.com",
            "password": "new-password",
        })

        assert resp.status_code == 201
        assert resp.json()["approval_status"] == "pending"
        created = mock_session.add.call_args.args[0]
        assert created.username == "newuser"
        assert created.approval_status == "pending"
        mock_session.commit.assert_awaited()

    def test_register_duplicate_username(self, auth_client, mock_session, fake_user):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = fake_user
        mock_session.execute.return_value = mock_result

        resp = auth_client.post("/auth/register", json={
            "username": "testuser",
            "display_name": "Test User",
            "password": "new-password",
        })

        assert resp.status_code == 409


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------
class TestGetMe:
    def test_returns_user(self, auth_client, fake_user):
        resp = auth_client.get("/auth/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == fake_user.id
        assert data["username"] == fake_user.username


# ---------------------------------------------------------------------------
# POST /auth/change-password
# ---------------------------------------------------------------------------
class TestChangePassword:
    def test_success(self, auth_client, mock_session, fake_user):
        fake_user.hashed_password = hash_password("old-pass")

        resp = auth_client.post("/auth/change-password", json={
            "old_password": "old-pass",
            "new_password": "new-pass",
        })
        assert resp.status_code == 200
        mock_session.commit.assert_awaited()

    def test_wrong_old_password(self, auth_client, fake_user):
        fake_user.hashed_password = hash_password("real-old-pass")

        resp = auth_client.post("/auth/change-password", json={
            "old_password": "wrong",
            "new_password": "new-pass",
        })
        assert resp.status_code == 400


class TestUserMemoryApi:
    def test_list_memories_supports_memory_type_filter(self, auth_client, mock_session):
        profile_mem = MagicMock()
        profile_mem.id = 1
        profile_mem.memory_type = "profile"
        profile_mem.key = "preference"
        profile_mem.value = {"theme": "dark"}
        profile_mem.updated_at = datetime(2026, 6, 9, tzinfo=timezone.utc)

        mock_result = MagicMock()
        mock_result.scalars.return_value = [profile_mem]
        mock_session.execute.return_value = mock_result

        resp = auth_client.get("/auth/me/memory?memory_type=profile")
        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["memory_type"] == "profile"
        assert data[0]["key"] == "preference"

    def test_list_memories_supports_production_memory_filter(self, auth_client, mock_session):
        production_mem = MagicMock()
        production_mem.id = 1
        production_mem.memory_type = "production_memory"
        production_mem.key = "production_memory"
        production_mem.value = {"events": []}
        production_mem.updated_at = datetime(2026, 6, 9, tzinfo=timezone.utc)

        mock_result = MagicMock()
        mock_result.scalars.return_value = [production_mem]
        mock_session.execute.return_value = mock_result

        resp = auth_client.get("/auth/me/memory?memory_type=production_memory")
        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["memory_type"] == "production_memory"
        assert data[0]["key"] == "production_memory"

    def test_upsert_memory_accepts_memory_type(self, auth_client, mock_session):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = mock_result

        created = MagicMock()
        created.id = 1
        created.memory_type = "activity_profile"
        created.key = "user_profile"
        created.value = {"summary": "AI researcher"}
        created.updated_at = datetime(2026, 6, 9, tzinfo=timezone.utc)
        mock_session.refresh = AsyncMock(side_effect=lambda obj: None)

        def capture_add(obj):
            created.user_id = obj.user_id
            created.memory_type = obj.memory_type
            created.key = obj.key
            created.value = obj.value
            mock_session._created = obj

        mock_session.add.side_effect = capture_add

        resp = auth_client.put(
            "/auth/me/memory/user_profile",
            json={"memory_type": "activity_profile", "value": {"summary": "AI researcher"}},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["memory_type"] == "activity_profile"
        assert data["key"] == "user_profile"
        assert mock_session._created.memory_type == "activity_profile"
