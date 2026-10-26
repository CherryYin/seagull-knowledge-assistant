import asyncio
import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from pkg.schemas.application.podcast import (
    PodcastAudioPreflightRequest,
    PodcastConfigurationRead,
    PodcastDraft,
    PodcastApprovalRead,
)
from pkg.services.application import podcast_audio


def confirmed_draft():
    now = datetime.now(timezone.utc)
    spoken = "Topic\n\n这是已确认的口播。"
    return PodcastDraft(
        asset_id="episode",
        status="draft",
        title="Topic",
        brief="My angle",
        draft_content="这是已确认的口播。",
        source_refs=["source"],
        input_hash="a" * 64,
        spoken_text=spoken,
        materials=[],
        configuration=PodcastConfigurationRead(
            asset_id="episode",
            revision=1,
            created_at=now,
            updated_at=now,
            information_cutoff_at=now,
        ),
        approval_status="current",
        approval_issues=[],
        latest_approval=PodcastApprovalRead(
            id="approval",
            asset_id="episode",
            config_revision=1,
            script_hash=hashlib.sha256(spoken.encode()).hexdigest(),
            input_hash="a" * 64,
            spoken_text=spoken,
            source_snapshot=[],
            config_snapshot={},
            approved_by="owner",
            created_at=now,
        ),
    )


def credential(**changes):
    return SimpleNamespace(
        **{
            "id": 7,
            "label": "Personal Qwen",
            "user_id": "owner",
            "provider": "qwen",
            "is_enabled": True,
            "secret_encrypted": "encrypted-secret-not-for-response",
            "config": {"region": "cn-beijing", "secret": "must-never-be-exposed"},
            **changes,
        }
    )


def session_results(*values, abandoned_count=0):
    session = AsyncMock()
    session.add = MagicMock()
    results = []
    for value in values:
        result = MagicMock()
        result.scalar_one_or_none.return_value = value
        results.append(result)
    count_result = MagicMock()
    count_result.scalar_one.return_value = abandoned_count
    session.execute.side_effect = [*results, count_result]
    return session


def request(**changes):
    return PodcastAudioPreflightRequest(
        **{
            "base_input_hash": "a" * 64,
            "budget_limit": "2",
            "credential_id": 7,
            "price_per_10k_characters": "0.8",
            **changes,
        }
    )


@pytest.mark.parametrize(
    "text",
    [
        "",
        "短稿",
        "a" * 600,
        "a" * 601,
        "😀" * 601,
        "中文。\n\n" * 500,
        "a " * 700,
        "开场\n\n" + "字" * 80300,
    ],
)
def test_segmentation_preserves_exact_text_and_bounds_each_segment(text):
    segments = podcast_audio.segment_spoken_text(text)
    assert "".join(segments) == text
    assert all(
        segment and podcast_audio.reserved_characters(segment) <= 600 for segment in segments
    )
    assert segments == podcast_audio.segment_spoken_text(text)
    plans = podcast_audio.plan_audio_segments(text, Decimal("0.8"))
    assert [segment.position for segment in plans] == list(range(len(plans)))
    for segment in plans:
        assert segment.text_hash == hashlib.sha256(segment.spoken_text.encode()).hexdigest()
        assert (
            segment.estimated_cost
            >= Decimal(segment.reserved_character_count) * Decimal("0.8") / 10000
        )


def test_segmentation_prefers_a_natural_boundary_without_discarding_spaces():
    text = "a" * 160 + "。 \n" + "b" * 400
    segments = podcast_audio.segment_spoken_text(text)
    assert segments[0] == "a" * 160 + "。 \n"
    assert "".join(segments) == text


def test_unknown_prices_remain_unknown_and_small_costs_round_up():
    assert podcast_audio.plan_audio_segments("A", None)[0].estimated_cost is None
    assert podcast_audio.plan_audio_segments("A", Decimal("0.000001"))[0].estimated_cost == Decimal(
        "0.0001"
    )
    assert podcast_audio.reserved_characters("中A😀") == 8


@pytest.mark.parametrize(
    "changes",
    [
        {"budget_limit": "0"},
        {"budget_limit": "-1"},
        {"budget_limit": "2.0001"},
        {"budget_limit": "0.12345"},
        {"budget_limit": "NaN"},
        {"budget_limit": "Infinity"},
        {"credential_id": True},
        {"credential_id": 0},
        {"credential_id": "7"},
        {"price_per_10k_characters": "0"},
        {"price_per_10k_characters": "NaN"},
        {"price_per_10k_characters": "0.0000001"},
        {"price_per_10k_characters": "10001"},
        {"api_key": "do-not-accept-secrets"},
        {"authorize": True},
        {"base_input_hash": "stale"},
    ],
)
def test_preflight_request_rejects_invalid_money_secrets_and_fake_authorization(changes):
    with pytest.raises(ValidationError):
        request(**changes)


@pytest.mark.asyncio
async def test_preflight_uses_current_snapshot_owned_credential_and_never_writes():
    session = session_results(credential(), None)
    draft = confirmed_draft()
    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=draft)
    ) as read:
        result = await podcast_audio.preflight_podcast_audio(
            session, user_id="owner", asset_id="episode", body=request()
        )
    assert read.call_args.kwargs == {"user_id": "owner", "asset_id": "episode"}
    assert result.checks_passed and result.credential_checks_passed
    assert result.budget_sufficient is True
    assert result.pricing_source == "user_entered" and not result.pricing_verified
    assert (
        "".join(segment.spoken_text for segment in result.segments)
        == draft.latest_approval.spoken_text
    )
    assert result.script_hash == draft.latest_approval.script_hash
    assert result.estimated_cost == sum(segment.estimated_cost for segment in result.segments)
    assert result.audio_generation_available is False
    response = result.model_dump_json()
    assert "encrypted-secret" not in response and "must-never-be-exposed" not in response
    credential_query = session.execute.call_args_list[0].args[0].compile()
    assert "owner" in credential_query.params.values() and 7 in credential_query.params.values()
    session.add.assert_not_called()
    session.flush.assert_not_awaited()
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_credential_or_price_is_unknown_not_zero_and_never_falls_back():
    session = session_results(None)
    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=confirmed_draft())
    ):
        result = await podcast_audio.preflight_podcast_audio(
            session,
            user_id="owner",
            asset_id="episode",
            body=request(credential_id=None, price_per_10k_characters=None),
        )
    assert not result.checks_passed and not result.credential_checks_passed
    assert result.credential_id is None and result.estimated_cost is None
    assert result.budget_sufficient is None and result.pricing_source is None
    assert {issue.code for issue in result.issues} == {"credential_required", "price_unknown"}
    assert all(segment.estimated_cost is None for segment in result.segments)
    assert session.execute.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"is_enabled": False},
        {"provider": "minimax"},
        {"config": {"region": "intl"}},
        {"secret_encrypted": ""},
    ],
)
async def test_unusable_credentials_block_preflight(changes):
    session = session_results(credential(**changes), None)
    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=confirmed_draft())
    ):
        result = await podcast_audio.preflight_podcast_audio(
            session, user_id="owner", asset_id="episode", body=request()
        )
    assert not result.credential_checks_passed and not result.checks_passed
    assert result.issues[0].code == "credential_unavailable"


@pytest.mark.asyncio
async def test_foreign_or_deleted_credential_is_not_found():
    session = session_results(None)
    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=confirmed_draft())
    ):
        with pytest.raises(HTTPException) as error:
            await podcast_audio.preflight_podcast_audio(
                session, user_id="owner", asset_id="episode", body=request()
            )
    assert error.value.status_code == 404
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["queued", "generating", "assembling", "outcome_unknown"])
async def test_active_or_unknown_task_prevents_retry_suggestions(status):
    session = session_results(credential(), SimpleNamespace(id="active", status=status))
    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=confirmed_draft())
    ):
        result = await podcast_audio.preflight_podcast_audio(
            session, user_id="owner", asset_id="episode", body=request()
        )
    assert not result.checks_passed and result.active_render_status == status
    assert result.issues[0].code == "active_render"


@pytest.mark.asyncio
async def test_over_budget_result_is_a_blocker_not_a_fake_hard_spending_cap():
    session = session_results(credential(), None)
    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=confirmed_draft())
    ):
        result = await podcast_audio.preflight_podcast_audio(
            session, user_id="owner", asset_id="episode", body=request(budget_limit="0.0001")
        )
    assert not result.checks_passed and result.budget_sufficient is False
    assert result.issues[0].code == "budget_exceeded"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        "hash",
        "unconfirmed",
        "stale",
        "missing",
        "issues",
        "snapshot_text",
        "snapshot_hash",
        "snapshot_input",
        "archived",
    ],
)
async def test_only_a_current_consistent_script_snapshot_can_be_used(change):
    draft = confirmed_draft()
    if change == "hash":
        draft.input_hash = "b" * 64
    elif change == "archived":
        draft.status = "archived"
    elif change in {"unconfirmed", "stale"}:
        draft.approval_status = change
    elif change == "missing":
        draft.latest_approval = None
    elif change == "issues":
        draft.approval_issues = ["已归档播客只读"]
    elif change == "snapshot_text":
        draft.latest_approval.spoken_text = "Tampered"
    elif change == "snapshot_hash":
        draft.latest_approval.script_hash = "f" * 64
    elif change == "snapshot_input":
        draft.latest_approval.input_hash = "f" * 64
    session = session_results()
    with patch.object(podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=draft)):
        with pytest.raises(HTTPException) as error:
            await podcast_audio.preflight_podcast_audio(
                session, user_id="owner", asset_id="episode", body=request()
            )
    assert error.value.status_code == 409
    session.execute.assert_not_awaited()


def test_preflight_endpoint_is_authenticated_binds_user_and_returns_decimal_strings(client):
    from pkg.api.app import app
    from pkg.api.deps import get_current_user

    session = session_results(credential(), None)

    with patch.object(
        podcast_audio, "get_podcast_draft", new=AsyncMock(return_value=confirmed_draft())
    ):
        result = asyncio.run(
            podcast_audio.preflight_podcast_audio(
                session, user_id="owner", asset_id="episode", body=request()
            )
        )
    with patch(
        "pkg.api.assets.preflight_podcast_audio", new=AsyncMock(return_value=result)
    ) as preflight:
        response = client.post(
            "/assets/episode/podcast/audio-preflight", json=request().model_dump(mode="json")
        )
    assert response.status_code == 200
    assert response.json()["budget_limit"] == "2"
    assert response.json()["audio_generation_available"] is False
    assert preflight.call_args.kwargs["user_id"] == "test-user-001"
    assert preflight.call_args.kwargs["body"].price_per_10k_characters == Decimal("0.8")
    app.dependency_overrides.pop(get_current_user)
    assert (
        client.post(
            "/assets/episode/podcast/audio-preflight", json=request().model_dump(mode="json")
        ).status_code
        == 401
    )


def test_preflight_endpoint_rejects_execution_or_secret_injection(client):
    response = client.post(
        "/assets/episode/podcast/audio-preflight",
        json={**request().model_dump(mode="json"), "execute": True, "secret": "forbidden"},
    )
    assert response.status_code == 422
