import json
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from pkg.schemas.application.wechat_statistics import WechatStatisticsPayload, WechatStatisticsRequest
from pkg.services.application import wechat_statistics as service
from pkg.services.foundation.wechat_statistics import WechatStatisticsError, fetch_article_statistics


def provider_payload():
    return {"list": [{"ref_date": "2026-01-01", "msgid": "12345_1", "title": "Published episode",
                      "content_url": "https://mp.weixin.qq.com/s/article",
                      "detail_list": [{"stat_date": "2026-01-03", "read_user": 42, "share_user": 0, "read_finish_rate": 0.6},
                                      {"stat_date": "2026-01-02", "read_user": 30}]}], "is_delay": False}


def request_body():
    return WechatStatisticsRequest(credential_id=7, publication_date="2026-01-01")


@pytest.mark.asyncio
async def test_new_api_uses_stable_token_and_same_publication_date_with_no_writes():
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path == "/cgi-bin/stable_token":
            assert json.loads(request.content) == {"grant_type": "client_credential", "appid": "wx-own", "secret": "private-secret", "force_refresh": False}
            return httpx.Response(200, json={"access_token": "private-token"})
        assert request.url.path == "/datacube/getarticletotaldetail"
        assert request.url.host == "api.weixin.qq.com"
        assert json.loads(request.content) == {"begin_date": "2026-01-01", "end_date": "2026-01-01"}
        return httpx.Response(200, json=provider_payload())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await fetch_article_statistics(app_id="wx-own", app_secret="private-secret", publication_date=date(2026, 1, 1), client=client)
    assert len(requests) == 2
    assert result.list[0].detail_list[-1].read_user == 42
    assert result.list[0].detail_list[-1].share_user == 0
    assert result.list[0].detail_list[-1].like_user is None
    assert "private-secret" not in result.model_dump_json()
    assert "private-token" not in result.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize("code,expected", [(40164, "白名单"), (48001, "权限"), (40125, "AppSecret"), (45009, "上限"), (99999, "返回错误")])
async def test_provider_errors_are_safe_and_never_retried(code, expected):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"errcode": code, "errmsg": "private-token private-secret raw-debug"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(WechatStatisticsError) as error:
            await fetch_article_statistics(app_id="own", app_secret="private-secret", publication_date=date(2026, 1, 1), client=client)
    assert expected in str(error.value)
    assert "private" not in str(error.value)
    assert len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {}, {"list": None}, {"list": [{"ref_date": "2026-01-02", "msgid": "123_1", "detail_list": []}]},
    {"list": [{"ref_date": "2026-01-01", "msgid": "123_1", "detail_list": [{"stat_date": "2026-02-01", "read_user": 5}]}]},
    {"list": [{"ref_date": "2026-01-01", "msgid": "123_1", "detail_list": [{"stat_date": "2026-01-01", "read_user": -1}]}]},
    {"list": [{"ref_date": "2026-01-01", "msgid": "123_1", "content_url": "javascript:alert(1)", "detail_list": []}]},
])
async def test_invalid_data_never_becomes_zero_counts(payload):
    def handler(request):
        return httpx.Response(200, json={"access_token": "token"} if "stable_token" in request.url.path else payload)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(WechatStatisticsError):
            await fetch_article_statistics(app_id="own", app_secret="secret", publication_date=date(2026, 1, 1), client=client)


@pytest.mark.asyncio
async def test_empty_success_and_unknown_delay_are_not_provider_failure():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"access_token": "token"} if "stable_token" in request.url.path else {"list": []}))) as client:
        result = await fetch_article_statistics(app_id="own", app_secret="secret", publication_date=date(2026, 1, 1), client=client)
    assert result.list == []
    assert result.is_delay is None


@pytest.mark.asyncio
async def test_network_errors_do_not_leak_request_credentials():
    def handler(request):
        raise httpx.ReadTimeout("private-secret private-token", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(WechatStatisticsError) as error:
            await fetch_article_statistics(app_id="own", app_secret="private-secret", publication_date=date(2026, 1, 1), client=client)
    assert "private" not in str(error.value)


@pytest.fixture
def account():
    return SimpleNamespace(id=7, provider="wechat_official_account", user_id="owner", is_enabled=True, config={"app_id": "wx-own"}, secret_encrypted="encrypted")


@pytest.mark.asyncio
async def test_sync_persists_allowlisted_snapshot_with_owned_account(mock_session, account):
    mock_session.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=account))
    with patch.object(service, "get_user_api_credential", new=AsyncMock(return_value=account)) as owned, patch.object(service, "decrypt_secret", return_value="secret"), patch.object(service, "fetch_article_statistics", new=AsyncMock(return_value=WechatStatisticsPayload(**provider_payload()))) as fetch:
        result = await service.sync_statistics(mock_session, user_id="owner", body=request_body())
    assert owned.call_args.kwargs == {"user_id": "owner", "credential_id": 7}
    assert result.credential_id == 7
    snapshot = mock_session.add.call_args.args[0]
    assert snapshot.user_id == "owner"
    assert len(snapshot.account_hash) == 64
    assert "secret" not in str(snapshot.payload)
    assert fetch.call_args.kwargs["publication_date"] == date(2026, 1, 1)
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["foreign", "disabled", "wrong_provider", "missing_appid"])
async def test_invalid_account_never_decrypts_or_calls_wechat(mock_session, account, kind):
    if kind == "disabled":
        account.is_enabled = False
    elif kind == "wrong_provider":
        account.provider = "qwen"
    elif kind == "missing_appid":
        account.config = {}
    with patch.object(service, "get_user_api_credential", new=AsyncMock(return_value=None if kind == "foreign" else account)), patch.object(service, "decrypt_secret") as decrypt, patch.object(service, "fetch_article_statistics", new=AsyncMock()) as fetch:
        with pytest.raises(HTTPException) as error:
            await service.sync_statistics(mock_session, user_id="owner", body=request_body())
    assert error.value.status_code == (404 if kind == "foreign" else 409)
    decrypt.assert_not_called()
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_sync_does_not_replace_saved_data(mock_session, account):
    with patch.object(service, "get_user_api_credential", new=AsyncMock(return_value=account)), patch.object(service, "decrypt_secret", return_value="secret"), patch.object(service, "fetch_article_statistics", new=AsyncMock(side_effect=WechatStatisticsError("No permission"))):
        with pytest.raises(HTTPException):
            await service.sync_statistics(mock_session, user_id="owner", body=request_body())
    mock_session.add.assert_not_called()
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_changed_account_during_sync_is_not_saved(mock_session, account):
    other = SimpleNamespace(**{**account.__dict__, "config": {"app_id": "wx-other"}})
    mock_session.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=other))
    with patch.object(service, "get_user_api_credential", new=AsyncMock(return_value=account)), patch.object(service, "decrypt_secret", return_value="secret"), patch.object(service, "fetch_article_statistics", new=AsyncMock(return_value=WechatStatisticsPayload(**provider_payload()))):
        with pytest.raises(HTTPException) as error:
            await service.sync_statistics(mock_session, user_id="owner", body=request_body())
    assert error.value.status_code == 409
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_saved_read_has_account_hash_and_owner_scope_and_no_remote_call(mock_session, account):
    mock_session.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=None))
    with patch.object(service, "get_user_api_credential", new=AsyncMock(return_value=account)), patch.object(service, "decrypt_secret") as decrypt, patch.object(service, "fetch_article_statistics", new=AsyncMock()) as fetch:
        assert await service.get_statistics(mock_session, user_id="owner", body=request_body()) is None
    statement = mock_session.execute.call_args.args[0]
    values = statement.compile().params.values()
    assert "owner" in values
    assert 7 in values
    assert date(2026, 1, 1) in values
    assert any(isinstance(value, str) and len(value) == 64 for value in values)
    decrypt.assert_not_called()
    fetch.assert_not_awaited()


@pytest.mark.parametrize("overrides", [{"publication_date": "2025-10-31"}, {"publication_date": "2099-01-01"}, {"credential_id": 0}, {"user_id": "other"}])
def test_invalid_dates_and_scope_injection(overrides):
    with pytest.raises(ValidationError):
        WechatStatisticsRequest(**{"credential_id": 7, "publication_date": "2026-01-01", **overrides})


def test_routes_preserve_owner_scope_and_read_does_not_sync(client):
    with patch("pkg.api.wechat_statistics.get_statistics", new=AsyncMock(return_value=None)) as saved, patch("pkg.api.wechat_statistics.sync_statistics", new=AsyncMock(side_effect=HTTPException(status_code=409, detail="No permission"))) as sync:
        response = client.get("/knowledge/wechat-statistics?credential_id=7&publication_date=2026-01-01")
        assert response.status_code == 200
        assert response.json() == {"snapshot": None}
        assert saved.call_args.kwargs["user_id"] == "test-user-001"
        sync.assert_not_awaited()
        response = client.post("/knowledge/wechat-statistics/sync", json={"credential_id": 7, "publication_date": "2026-01-01"})
        assert response.status_code == 409
        assert sync.call_args.kwargs["user_id"] == "test-user-001"
    assert client.get("/knowledge/wechat-statistics?credential_id=7&publication_date=2099-01-01").status_code == 422
    assert client.post("/knowledge/wechat-statistics/sync", json={"credential_id": 7, "publication_date": "2026-01-01", "secret": "inject"}).status_code == 422
