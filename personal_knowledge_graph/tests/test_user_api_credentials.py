from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import ProgrammingError

from pkg.models.user_api_credential import UserApiCredential
from pkg.schemas.user_api_credential import UserApiCredentialCreate, UserApiCredentialUpdate
from pkg.services.cross_cutting.user_api_credentials import (
    create_user_api_credential,
    delete_user_api_credential,
    get_default_user_api_credential_secret,
    get_user_api_credential,
    list_user_api_credentials,
    update_user_api_credential,
    UserApiCredentialsStorageUnavailableError,
)


def test_wechat_official_account_is_a_supported_credential_provider():
    credential = UserApiCredentialCreate(
        provider="wechat_official_account",
        secret="app-secret",
        config={"app_id": "wx-app", "default_thumb_media_id": "cover-media"},
    )

    assert credential.provider == "wechat_official_account"


class MissingTableError(Exception):
    sqlstate = "42P01"


def missing_user_api_credentials_table_error() -> ProgrammingError:
    return ProgrammingError("SELECT ... FROM user_api_credentials", {}, MissingTableError())


@pytest.mark.asyncio
async def test_create_user_api_credential_encrypts_and_masks_secret():
    session = AsyncMock()
    session.add = MagicMock()
    created = UserApiCredential(
        id=1,
        user_id="user-1",
        provider="newsapi",
        label="default",
        secret_encrypted="enc",
        secret_masked="****1234",
        config={},
        is_enabled=True,
        is_default=True,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    async def fake_refresh(obj):
        obj.id = 1
        obj.created_at = datetime.now()
        obj.updated_at = datetime.now()

    session.refresh.side_effect = fake_refresh
    session.execute.return_value = MagicMock(scalars=MagicMock(return_value=[]))

    with patch("pkg.services.cross_cutting.user_api_credentials.encrypt_secret", return_value="encrypted-secret"), \
         patch("pkg.services.cross_cutting.user_api_credentials.mask_secret", return_value="****cret"):
        result = await create_user_api_credential(
            session,
            user_id="user-1",
            body=UserApiCredentialCreate(provider="newsapi", label="default", secret="secret", is_default=True),
        )

    assert result.user_id == "user-1"
    added = session.add.call_args.args[0]
    assert added.secret_encrypted == "encrypted-secret"
    assert added.secret_masked == "****cret"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_user_api_credential_returns_none_for_wrong_owner():
    session = AsyncMock()
    session.get.return_value = UserApiCredential(
        id=1,
        user_id="other-user",
        provider="newsapi",
        label="default",
        secret_encrypted="enc",
        secret_masked="****1234",
        config={},
        is_enabled=True,
        is_default=False,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    result = await get_user_api_credential(session, user_id="user-1", credential_id=1)

    assert result is None


@pytest.mark.asyncio
async def test_update_user_api_credential_updates_secret_when_present():
    session = AsyncMock()
    credential = UserApiCredential(
        id=1,
        user_id="user-1",
        provider="newsapi",
        label="default",
        secret_encrypted="old",
        secret_masked="****old",
        config={},
        is_enabled=True,
        is_default=False,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    session.get.return_value = credential

    with patch("pkg.services.cross_cutting.user_api_credentials.encrypt_secret", return_value="new-encrypted"), \
         patch("pkg.services.cross_cutting.user_api_credentials.mask_secret", return_value="****new"):
        result = await update_user_api_credential(
            session,
            user_id="user-1",
            credential_id=1,
            body=UserApiCredentialUpdate(secret="new-secret", is_default=False),
        )

    assert result is credential
    assert credential.secret_encrypted == "new-encrypted"
    assert credential.secret_masked == "****new"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_user_api_credential_returns_false_when_missing():
    session = AsyncMock()
    session.get.return_value = None

    deleted = await delete_user_api_credential(session, user_id="user-1", credential_id=1)

    assert deleted is False
    session.delete.assert_not_called()


@pytest.mark.asyncio
async def test_list_user_api_credentials_returns_empty_when_table_missing():
    session = AsyncMock()
    session.execute.side_effect = missing_user_api_credentials_table_error()

    result = await list_user_api_credentials(session, user_id="user-1")

    assert result == []
    session.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_user_api_credential_raises_storage_unavailable_when_table_missing():
    session = AsyncMock()
    session.add = MagicMock()
    session.flush.side_effect = missing_user_api_credentials_table_error()

    with patch("pkg.services.cross_cutting.user_api_credentials.encrypt_secret", return_value="encrypted-secret"), \
         patch("pkg.services.cross_cutting.user_api_credentials.mask_secret", return_value="****cret"):
        with pytest.raises(UserApiCredentialsStorageUnavailableError, match="run database migrations"):
            await create_user_api_credential(
                session,
                user_id="user-1",
                body=UserApiCredentialCreate(provider="newsapi", label="default", secret="secret"),
            )

    session.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_default_user_api_credential_secret_falls_back_when_table_missing():
    session = AsyncMock()

    with patch(
        "pkg.services.cross_cutting.user_api_credentials.get_default_user_api_credential",
        side_effect=missing_user_api_credentials_table_error(),
    ):
        secret, config = await get_default_user_api_credential_secret(session, user_id="user-1", provider="newsapi")

    assert secret is None
    assert config == {}
    session.rollback.assert_awaited_once()
