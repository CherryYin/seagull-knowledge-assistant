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


class TestUserApiCredentialApi:
    def test_list_api_credentials_returns_items(self, auth_client, mock_session, fake_user):
        from pkg.models.user_api_credential import UserApiCredential

        item = UserApiCredential(
            id=1,
            user_id=fake_user.id,
            provider="newsapi",
            label="default",
            secret_encrypted="enc",
            secret_masked="****1234",
            config={"base_url": "https://newsapi.org/v2"},
            is_enabled=True,
            is_default=True,
            created_at=datetime(2026, 6, 25, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 25, tzinfo=timezone.utc),
        )
        mock_result = MagicMock()
        mock_result.scalars.return_value = [item]
        mock_session.execute.return_value = mock_result

        resp = auth_client.get("/auth/me/api-credentials")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["provider"] == "newsapi"
        assert data["items"][0]["secret_masked"] == "****1234"

    def test_create_api_credential_returns_masked_record(self, auth_client, mock_session, fake_user):
        mock_session.add = MagicMock()
        mock_session.execute.return_value = MagicMock(scalars=MagicMock(return_value=[]))

        async def fake_refresh(obj):
            obj.id = 1
            obj.created_at = datetime(2026, 6, 25, tzinfo=timezone.utc)
            obj.updated_at = datetime(2026, 6, 25, tzinfo=timezone.utc)

        mock_session.refresh = AsyncMock(side_effect=fake_refresh)

        resp = auth_client.post(
            "/auth/me/api-credentials",
            json={
                "provider": "newsapi",
                "label": "default",
                "secret": "super-secret-value",
                "config": {"base_url": "https://newsapi.org/v2"},
                "is_enabled": True,
                "is_default": True,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["provider"] == "newsapi"
        assert data["secret_masked"].endswith("alue")
        assert "secret" not in data

    @pytest.mark.asyncio
    async def test_create_api_credential_returns_503_when_crypto_key_missing(self, mock_session, fake_user):
        from fastapi import HTTPException
        from pkg.api.auth import create_api_credential
        from pkg.schemas.user_api_credential import UserApiCredentialCreate

        with patch("pkg.services.cross_cutting.credentials_crypto.settings.CREDENTIAL_ENCRYPTION_KEY", ""):
            with pytest.raises(HTTPException) as exc_info:
                await create_api_credential(
                    UserApiCredentialCreate(provider="newsapi", label="default", secret="super-secret-value"),
                    user=fake_user,
                    session=mock_session,
                )

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "CREDENTIAL_ENCRYPTION_KEY is not configured"
        mock_session.rollback.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_create_api_credential_returns_503_when_storage_unavailable(self, mock_session, fake_user):
        from fastapi import HTTPException
        from pkg.api.auth import create_api_credential
        from pkg.schemas.user_api_credential import UserApiCredentialCreate
        from pkg.services.cross_cutting.user_api_credentials import UserApiCredentialsStorageUnavailableError

        with patch(
            "pkg.api.auth.create_user_api_credential",
            side_effect=UserApiCredentialsStorageUnavailableError("User API credentials table is missing; run database migrations"),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await create_api_credential(
                    UserApiCredentialCreate(provider="newsapi", label="default", secret="super-secret-value"),
                    user=fake_user,
                    session=mock_session,
                )

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "User API credentials table is missing; run database migrations"

    def test_get_api_credential_returns_404_when_missing(self, auth_client, mock_session):
        mock_session.get.return_value = None

        resp = auth_client.get("/auth/me/api-credentials/1")
        assert resp.status_code == 404

    def test_patch_api_credential_updates_record(self, auth_client, mock_session, fake_user):
        from pkg.models.user_api_credential import UserApiCredential

        item = UserApiCredential(
            id=1,
            user_id=fake_user.id,
            provider="newsapi",
            label="default",
            secret_encrypted="enc",
            secret_masked="****1234",
            config={},
            is_enabled=True,
            is_default=False,
            created_at=datetime(2026, 6, 25, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 25, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = item

        resp = auth_client.patch(
            "/auth/me/api-credentials/1",
            json={"label": "work", "is_default": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["label"] == "work"
        assert data["is_default"] is True

    def test_delete_api_credential_returns_204(self, auth_client, mock_session, fake_user):
        from pkg.models.user_api_credential import UserApiCredential

        item = UserApiCredential(
            id=1,
            user_id=fake_user.id,
            provider="newsapi",
            label="default",
            secret_encrypted="enc",
            secret_masked="****1234",
            config={},
            is_enabled=True,
            is_default=False,
            created_at=datetime(2026, 6, 25, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 25, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = item

        resp = auth_client.delete("/auth/me/api-credentials/1")
        assert resp.status_code == 204
        mock_session.delete.assert_awaited_once()
