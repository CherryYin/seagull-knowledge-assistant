from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from pkg.schemas.application.podcast import PodcastAudioRenderRead


def authorization():
    return {
        "base_input_hash": "a" * 64,
        "budget_limit": "2",
        "credential_id": 7,
        "price_per_10k_characters": "0.8",
        "execution_fingerprint": "b" * 64,
        "idempotency_key": "explicit-authorization-001",
        "authorize_text_to_provider": True,
        "acknowledge_billing_uncertainty": True,
    }


def render():
    return PodcastAudioRenderRead(
        id="render-001",
        asset_id="episode",
        script_approval_id="approval-001",
        input_hash="a" * 64,
        status="queued",
        budget_limit="2",
        currency="CNY",
        estimated_cost="0.01",
        duration_seconds=None,
        file_sha256=None,
        segment_count=2,
        ready_segment_count=0,
        attempt_count=0,
        reported_characters=None,
        reported_cost=None,
        error_message=None,
        created_at=datetime.now(timezone.utc),
        completed_at=None,
    )


def test_audio_submission_preserves_authorization_and_current_user(client, mock_session):
    with patch(
        "pkg.api.assets.create_audio_render", new=AsyncMock(return_value=render())
    ) as create:
        response = client.post("/assets/episode/podcast/audio-renders", json=authorization())
    assert response.status_code == 200
    assert response.json()["reported_cost"] is None
    create.assert_awaited_once()
    assert create.call_args.args == (mock_session,)
    assert create.call_args.kwargs["user_id"] == "test-user-001"
    assert create.call_args.kwargs["asset_id"] == "episode"
    assert create.call_args.kwargs["body"].model_dump(mode="json") == authorization()


@pytest.mark.parametrize(
    "field,value",
    [
        ("authorize_text_to_provider", False),
        ("acknowledge_billing_uncertainty", False),
        ("execution_fingerprint", "invalid"),
        ("idempotency_key", "short"),
        ("budget_limit", "2.0001"),
        ("spoken_text", "forged"),
        ("config_snapshot", {}),
        ("api_key", "forged"),
        ("user_id", "foreign"),
    ],
)
def test_audio_submission_rejects_missing_consent_and_injection(client, field, value):
    body = {**authorization(), field: value}
    with patch("pkg.api.assets.create_audio_render", new=AsyncMock()) as create:
        response = client.post("/assets/episode/podcast/audio-renders", json=body)
    assert response.status_code == 422
    create.assert_not_awaited()


def test_audio_history_and_cancel_use_owned_scope(client):
    with patch(
        "pkg.api.assets.list_audio_renders", new=AsyncMock(return_value=[render()])
    ) as history:
        response = client.get("/assets/episode/podcast/audio-renders")
    assert response.status_code == 200
    assert response.json()["items"][0]["id"] == "render-001"
    assert history.call_args.kwargs == {"user_id": "test-user-001", "asset_id": "episode"}
    with patch(
        "pkg.api.assets.cancel_audio_render", new=AsyncMock(return_value=render())
    ) as cancel:
        response = client.post("/assets/episode/podcast/audio-renders/render-001/cancel")
    assert response.status_code == 200
    assert cancel.call_args.kwargs == {
        "user_id": "test-user-001",
        "asset_id": "episode",
        "render_id": "render-001",
    }


def test_audio_abandonment_requires_explicit_acknowledgment_and_preserves_owned_scope(client, mock_session):
    body = {"acknowledge_billing_uncertainty": True, "acknowledge_full_regeneration": True}
    task = render()
    task.status = "abandoned"
    with patch("pkg.api.assets.abandon_audio_render", new=AsyncMock(return_value=task)) as abandon:
        response = client.post("/assets/episode/podcast/audio-renders/render-001/abandon", json=body)
    assert response.status_code == 200
    assert response.json()["status"] == "abandoned"
    assert abandon.call_args.args == (mock_session,)
    assert abandon.call_args.kwargs["user_id"] == "test-user-001"
    assert abandon.call_args.kwargs["asset_id"] == "episode"
    assert abandon.call_args.kwargs["render_id"] == "render-001"
    assert abandon.call_args.kwargs["body"].model_dump() == body


@pytest.mark.parametrize("body", [
    {}, {"acknowledge_billing_uncertainty": True},
    {"acknowledge_billing_uncertainty": False, "acknowledge_full_regeneration": True},
    {"acknowledge_billing_uncertainty": True, "acknowledge_full_regeneration": False},
    {"acknowledge_billing_uncertainty": True, "acknowledge_full_regeneration": True, "abandoned_by": "foreign"},
])
def test_audio_abandonment_rejects_missing_consent_and_audit_injection(client, body):
    with patch("pkg.api.assets.abandon_audio_render", new=AsyncMock()) as abandon:
        response = client.post("/assets/episode/podcast/audio-renders/render-001/abandon", json=body)
    assert response.status_code == 422
    abandon.assert_not_awaited()


@pytest.mark.parametrize("status,completed,lease_seconds,allowed", [
    ("outcome_unknown", True, 900, True),
    ("outcome_unknown", False, 900, False),
    ("outcome_unknown", False, -1, True),
    ("outcome_unknown", False, None, True),
    ("failed", True, None, True), ("canceled", True, None, True),
    ("queued", False, None, False), ("generating", False, 900, False),
    ("assembling", False, 900, False), ("ready", True, None, False),
    ("abandoned", True, None, False),
])
def test_audio_abandonment_never_releases_a_live_execution_lease(status, completed, lease_seconds, allowed):
    from pkg.services.application.podcast_renders import _can_abandon
    now = datetime.now(timezone.utc)
    task = SimpleNamespace(status=status, completed_at=now if completed else None, lease_expires_at=None if lease_seconds is None else now + timedelta(seconds=lease_seconds))
    assert _can_abandon(task) is allowed


def test_audio_history_exposes_only_structured_diagnostics_for_owned_tasks(client):
    from pkg.schemas.application.podcast import PodcastAudioFailure, PodcastAudioAttemptRead

    task = render()
    task.status = "outcome_unknown"
    task.failure_details = PodcastAudioFailure(stage="audio_download", code="read_timeout", elapsed_ms=120000, http_status=200, provider_request_id="abc-123", exception_type="ReadTimeout", provider_error_code=None, retry_after_seconds=30)
    task.attempts = [PodcastAudioAttemptRead(id="attempt", segment_position=4, status="outcome_unknown", error_code="read_timeout", provider_request_id="abc-123", billable_characters=1000, started_at=task.created_at, completed_at=task.created_at, failure_details=task.failure_details)]
    with patch("pkg.api.assets.list_audio_renders", new=AsyncMock(return_value=[task])) as history:
        response = client.get("/assets/episode/podcast/audio-renders")
    assert response.status_code == 200
    result = response.json()["items"][0]
    assert result["failure_details"]["code"] == "read_timeout"
    assert result["failure_details"]["exception_type"] == "ReadTimeout"
    assert result["failure_details"]["retry_after_seconds"] == 30
    assert result["attempts"][0]["provider_request_id"] == "abc-123"
    assert result["attempts"][0]["billable_characters"] == 1000
    assert history.call_args.kwargs["user_id"] == "test-user-001"


def test_audio_download_is_private_binary_and_preserves_owner_errors(client):
    payload = b"ID3\x00\xff"
    with patch(
        "pkg.api.assets.download_audio_render", new=AsyncMock(return_value=payload)
    ) as download:
        response = client.get("/assets/episode/podcast/audio-renders/render-001/download")
    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"] == "audio/mpeg"
    assert "no-store" in response.headers["cache-control"]
    assert "seagull-podcast.mp3" in response.headers["content-disposition"]
    assert download.call_args.kwargs["user_id"] == "test-user-001"
    with patch(
        "pkg.api.assets.download_audio_render", new=AsyncMock(side_effect=HTTPException(404))
    ):
        assert (
            client.get("/assets/episode/podcast/audio-renders/foreign/download").status_code == 404
        )


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", ""),
        ("POST", ""),
        ("POST", "/render-001/cancel"),
        ("POST", "/render-001/abandon"),
        ("GET", "/render-001/download"),
    ],
)
def test_audio_routes_require_authentication(client, method, path):
    from pkg.api.app import app
    from pkg.api.deps import get_current_user

    override = app.dependency_overrides.pop(get_current_user)
    try:
        response = client.request(
            method, "/assets/episode/podcast/audio-renders" + path, json=authorization()
        )
        assert response.status_code == 401
    finally:
        app.dependency_overrides[get_current_user] = override
