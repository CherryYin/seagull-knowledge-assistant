import hashlib
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from pkg.models.application.asset import Asset
from pkg.models.application.podcast import PodcastConfig
from pkg.schemas.application.asset import AssetCreate, AssetUpdate
from pkg.schemas.application.podcast import PodcastConfigurationUpdate
from pkg.schemas.application.podcast import (
    PodcastApprovalRequest,
    PodcastCreate,
    PodcastDraft,
    PodcastDraftFields,
)
from pkg.services.application import assets, podcasts
from pkg.services.application.blog_generation import check_readiness


def test_podcast_script_confirmation_route_uses_current_user_and_expected_hash(client):
    state = PodcastDraft(
        title="Episode",
        asset_id="episode",
        status="draft",
        configuration=make_config(),
        input_hash="a" * 64,
        spoken_text="Episode",
        materials=[],
        approval_status="unconfirmed",
        approval_issues=["Missing script"],
    )
    with patch(
        "pkg.api.assets.approve_podcast_script", new=AsyncMock(return_value=state)
    ) as approve:
        response = client.post(
            "/assets/episode/podcast/script-approvals", json={"base_input_hash": "a" * 64}
        )
    assert response.status_code == 200
    assert response.json()["audio_generation_available"] is False
    assert approve.call_args.kwargs["user_id"] == "test-user-001"
    assert approve.call_args.kwargs["asset_id"] == "episode"
    assert approve.call_args.kwargs["body"].model_dump() == {"base_input_hash": "a" * 64}


def make_asset(asset_type="podcast", status="draft"):
    return Asset(
        id="episode",
        user_id="owner",
        title="Episode",
        asset_type=asset_type,
        status=status,
        brief="Brief",
        outline="Outline",
        draft_content="Script",
        reference_notes="Sources",
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        metadata_={},
    )


def make_config():
    now = datetime.now(timezone.utc)
    return PodcastConfig(
        asset_id="episode",
        revision=1,
        provider="qwen",
        region="cn-beijing",
        model="qwen3-tts-flash",
        voice_id="Cherry",
        target_duration_minutes=6,
        created_at=now,
        updated_at=now,
    )


def make_session(asset=None, configuration=None):
    session = AsyncMock()
    session.add = MagicMock()
    asset_result = MagicMock()
    asset_result.scalar_one_or_none.return_value = asset if asset is not None else make_asset()
    config_result = MagicMock()
    config_result.scalar_one_or_none.return_value = (
        configuration if configuration is not None else make_config()
    )
    session.execute.side_effect = [asset_result, config_result]
    return session


def test_catalog_contains_complete_model_specific_unique_voices():
    catalog = podcasts.get_voice_catalog()
    assert catalog.provider == "qwen" and catalog.region == "cn-beijing"
    assert catalog.model == "qwen3-tts-flash"
    ids = [voice.id for voice in catalog.items]
    assert len(ids) == len(set(ids)) == 48
    assert {"Cherry", "Ethan", "Eldric Sage", "Ono Anna", "Radio Gol", "Kiki"} <= set(ids)
    assert all(voice.name and voice.languages for voice in catalog.items)
    catalog.items.clear()
    assert len(podcasts.get_voice_catalog().items) == 48


def test_spoken_text_is_deterministic_without_silent_markdown_conversion():
    assert (
        podcasts._spoken_text(" Title  ", "  **Say this**  \r\nNext  \r")
        == "Title\n\n**Say this**\nNext"
    )
    assert podcasts._digest({"b": 1, "a": 2}) == podcasts._digest({"a": 2, "b": 1})


@pytest.mark.parametrize(
    "payload",
    [
        {"title": " "},
        {"title": "Episode", "source_refs": ["same", "same"]},
        {
            "title": "Episode",
            "source_refs": [str(index) for index in range(20)],
            "note_refs": ["extra"],
        },
        {"title": "Episode", "draft_content": "x" * 80001},
    ],
)
def test_draft_bounds(payload):
    with pytest.raises(ValidationError):
        PodcastDraftFields(**payload)


def paragraph_draft_payload():
    return {
        "title": "Episode",
        "draft_content": " First line  \r\nSecond line\r\n\r\nMy opinion ",
        "source_refs": ["material"],
        "paragraph_sources": [
            {
                "paragraph_index": position,
                "text_hash": hashlib.sha256(paragraph.encode()).hexdigest(),
                "material_refs": [{"kind": "source", "id": "material"}] if position == 0 else [],
            }
            for position, paragraph in enumerate(["First line\nSecond line", "My opinion"])
        ],
    }


def test_paragraph_sources_bind_normalized_text_and_selected_materials():
    body = PodcastCreate(**paragraph_draft_payload())
    assert len(body.paragraph_sources) == 2
    assert body.paragraph_sources[0].material_refs[0].id == "material"
    assert body.paragraph_sources[1].material_refs == []


@pytest.mark.parametrize(
    "change", ["body", "hash", "index", "unknown", "duplicate", "missing", "boolean_index"]
)
def test_paragraph_sources_reject_stale_or_forged_bindings(change):
    payload = paragraph_draft_payload()
    mapping = payload["paragraph_sources"][0]
    if change == "body":
        payload["draft_content"] += " changed"
    elif change == "hash":
        mapping["text_hash"] = "a" * 64
    elif change == "index":
        mapping["paragraph_index"] = 1
    elif change == "boolean_index":
        mapping["paragraph_index"] = False
    elif change == "unknown":
        mapping["material_refs"][0]["id"] = "unselected"
    elif change == "duplicate":
        mapping["material_refs"] *= 2
    elif change == "missing":
        payload["paragraph_sources"].pop()
    with pytest.raises(ValidationError):
        PodcastCreate(**payload)


@pytest.mark.parametrize(
    "field", ["spoken_text", "script_hash", "source_snapshot", "approved_by", "config_snapshot"]
)
def test_approval_cannot_accept_client_snapshots(field):
    with pytest.raises(ValidationError):
        PodcastApprovalRequest(**{"base_input_hash": "a" * 64, field: "forged"})


@pytest.mark.asyncio
async def test_unsupported_voice_creates_no_asset():
    session = AsyncMock()
    with pytest.raises(HTTPException) as invalid:
        await podcasts.create_podcast(
            session,
            user_id="owner",
            body=PodcastCreate(title="Episode", configuration={"voice_id": "invented"}),
        )
    assert invalid.value.status_code == 422
    session.execute.assert_not_awaited()
    session.commit.assert_not_awaited()


@pytest.mark.parametrize(
    "field,value",
    [("title", "Other title"), ("draft_content", "New script"), ("source_refs", ["source"])],
)
@pytest.mark.asyncio
async def test_generic_update_cannot_bypass_podcast_optimistic_save(field, value):
    session = make_session()
    with pytest.raises(HTTPException) as bypass:
        await assets.update_asset(
            session, user_id="owner", asset_id="episode", body=AssetUpdate(**{field: value})
        )
    assert bypass.value.status_code == 409
    session.commit.assert_not_awaited()


def test_podcast_approval_routes_reject_forged_inputs(client):
    response = client.post(
        "/assets/episode/podcast/script-approvals",
        json={"base_input_hash": "a" * 64, "spoken_text": "Forged"},
    )
    assert response.status_code == 422
    response = client.put(
        "/assets/episode/podcast/draft", json={"title": "Overwrite", "base_input_hash": "invalid"}
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {"base_revision": 0},
        {"base_revision": True},
        {"base_revision": 1, "target_duration_minutes": 0},
        {"base_revision": 1, "target_duration_minutes": 31},
        {"base_revision": 1, "target_duration_minutes": True},
        {"base_revision": 1, "model": "unsupported"},
        {"base_revision": 1, "region": "unknown"},
        {"base_revision": 1, "provider": "other"},
        {"base_revision": 1, "accepted_render_id": "forged"},
        {"base_revision": 1, "api_key": "must-not-be-accepted"},
        {"base_revision": 1, "information_cutoff_at": "2026-10-15T10:00:00"},
    ],
)
def test_configuration_rejects_invalid_or_server_owned_fields(payload):
    with pytest.raises(ValidationError):
        PodcastConfigurationUpdate(**payload)


@pytest.mark.asyncio
async def test_get_is_read_only_and_does_not_claim_generation_available():
    session = make_session()
    state = await podcasts.get_podcast(session, user_id="owner", asset_id="episode")
    assert state.configuration.revision == 1
    assert state.configuration.voice_id == "Cherry"
    assert state.audio_generation_available is False
    assert state.script_approval_available is True
    session.add.assert_not_called()
    session.commit.assert_not_awaited()
    statement = session.execute.call_args_list[0].args[0]
    assert statement.compile().params["user_id_1"] == "owner"


@pytest.mark.asyncio
async def test_foreign_asset_returns_404_before_reading_configuration():
    session = AsyncMock()
    session.execute.return_value.scalar_one_or_none = MagicMock(return_value=None)
    with pytest.raises(HTTPException) as error:
        await podcasts.get_podcast(session, user_id="other", asset_id="episode")
    assert error.value.status_code == 404
    assert session.execute.await_count == 1


@pytest.mark.asyncio
async def test_non_podcast_returns_conflict_without_creating_configuration():
    session = make_session(asset=make_asset("blog_post"))
    with pytest.raises(HTTPException) as error:
        await podcasts.get_podcast(session, user_id="owner", asset_id="episode")
    assert error.value.status_code == 409
    assert session.execute.await_count == 1
    session.add.assert_not_called()


@pytest.mark.asyncio
async def test_missing_configuration_is_not_created_by_get():
    session = make_session()
    missing = MagicMock()
    missing.scalar_one_or_none.return_value = None
    asset_result = MagicMock()
    asset_result.scalar_one_or_none.return_value = make_asset()
    session.execute.side_effect = [asset_result, missing]
    with pytest.raises(HTTPException) as error:
        await podcasts.get_podcast(session, user_id="owner", asset_id="episode")
    assert error.value.status_code == 409
    session.add.assert_not_called()
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("voice_id", ["Ethan", "Eldric Sage", "Ono Anna", "Radio Gol", "Kiki"])
async def test_update_persists_exact_voice_and_revision_without_generation(voice_id):
    session = make_session()
    body = PodcastConfigurationUpdate(
        base_revision=1, voice_id=voice_id, information_cutoff_at="2026-10-15T10:00:00+08:00"
    )
    state = await podcasts.update_podcast(session, user_id="owner", asset_id="episode", body=body)
    assert state.configuration.voice_id == voice_id
    assert state.configuration.revision == 2
    assert state.configuration.information_cutoff_at.utcoffset().total_seconds() == 28800
    assert state.audio_generation_available is False
    session.commit.assert_awaited_once()
    session.add.assert_not_called()
    assert all("FOR UPDATE" in str(call.args[0]) for call in session.execute.call_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "revision,voice_id,expected_status",
    [(2, "Ethan", 409), (1, "invalid", 422), (1, "EldricSage", 422)],
)
async def test_invalid_or_stale_update_does_not_save(revision, voice_id, expected_status):
    configuration = make_config()
    session = make_session(configuration=configuration)
    with pytest.raises(HTTPException) as error:
        await podcasts.update_podcast(
            session,
            user_id="owner",
            asset_id="episode",
            body=PodcastConfigurationUpdate(base_revision=revision, voice_id=voice_id),
        )
    assert error.value.status_code == expected_status
    assert configuration.revision == 1 and configuration.voice_id == "Cherry"
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_archived_podcast_configuration_is_read_only():
    session = make_session(asset=make_asset(status="archived"))
    with pytest.raises(HTTPException) as error:
        await podcasts.update_podcast(
            session,
            user_id="owner",
            asset_id="episode",
            body=PodcastConfigurationUpdate(base_revision=1),
        )
    assert error.value.status_code == 409
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_podcast_initializes_separate_configuration():
    session = AsyncMock()
    session.add = MagicMock()
    with patch.object(assets, "record_asset_production_event", new=AsyncMock()):
        asset = await assets.create_asset(
            session, user_id="owner", body=AssetCreate(title="Podcast", asset_type="podcast")
        )
    assert asset.asset_type == "podcast"
    configurations = [
        call.args[0]
        for call in session.add.call_args_list
        if isinstance(call.args[0], PodcastConfig)
    ]
    assert len(configurations) == 1 and configurations[0].asset_id == asset.id
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["ready_to_export", "exported", "published"])
async def test_generic_create_and_update_cannot_forge_audio_acceptance(status):
    session = make_session()
    with pytest.raises(HTTPException) as creation:
        await assets.create_asset(
            session,
            user_id="owner",
            body=AssetCreate(title="Podcast", asset_type="podcast", status=status),
        )
    assert creation.value.status_code == 409
    with pytest.raises(HTTPException) as update:
        await assets.update_asset(
            session, user_id="owner", asset_id="episode", body=AssetUpdate(status=status)
        )
    assert update.value.status_code == 409
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key", ["podcast", "podcast_config", "podcast_audio_render", "podcast_script_v1"]
)
async def test_generic_metadata_cannot_inject_podcast_internal_state(key):
    session = make_session()
    with pytest.raises(HTTPException) as creation:
        await assets.create_asset(
            session,
            user_id="owner",
            body=AssetCreate(
                title="Podcast", asset_type="podcast", metadata={key: {"accepted": True}}
            ),
        )
    assert creation.value.status_code == 422
    with pytest.raises(HTTPException) as update:
        await assets.update_asset(
            session,
            user_id="owner",
            asset_id="episode",
            body=AssetUpdate(metadata={key: {"accepted": True}}),
        )
    assert update.value.status_code == 422
    session.commit.assert_not_awaited()


def test_generic_metadata_replacement_preserves_paragraph_sources():
    mappings = paragraph_draft_payload()["paragraph_sources"]
    result = assets._preserve_workspace_metadata(
        {"podcast_script_v1": mappings, "ordinary": "old"}, {"ordinary": "new"}
    )
    assert result["podcast_script_v1"] == mappings
    assert result["ordinary"] == "new"


def test_text_readiness_cannot_masquerade_as_podcast_delivery():
    asset = make_asset()
    asset.source_refs = ["source"]
    ready, blockers, _, _ = check_readiness(asset)
    assert not ready
    assert any("accepted audio render" in blocker for blocker in blockers)


def test_voice_catalog_route_is_authenticated_and_complete(client):
    response = client.get("/assets/podcast/voices")
    assert response.status_code == 200
    assert len(response.json()["items"]) == 48
    from pkg.api.deps import get_current_user
    from pkg.api.app import app

    app.dependency_overrides.pop(get_current_user)
    assert client.get("/assets/podcast/voices").status_code == 401


@pytest.mark.parametrize(
    "payload",
    [
        {"base_revision": 1, "voice_id": "Ethan", "accepted_render_id": "fake"},
        {"base_revision": 1, "region": "unknown"},
        {"base_revision": 0},
    ],
)
def test_configuration_api_rejects_invalid_contract(client, payload):
    response = client.put("/assets/episode/podcast", json=payload)
    assert response.status_code == 422


def test_podcast_state_routes_use_current_user(client):
    state = {
        "asset_id": "episode",
        "configuration": make_config(),
        "script_approval_available": True,
        "audio_generation_available": False,
    }
    with patch("pkg.api.assets.get_podcast", new=AsyncMock(return_value=state)) as read:
        response = client.get("/assets/episode/podcast")
    assert response.status_code == 200
    assert read.call_args.kwargs == {"user_id": "test-user-001", "asset_id": "episode"}
    with patch("pkg.api.assets.update_podcast", new=AsyncMock(return_value=state)) as update:
        response = client.put(
            "/assets/episode/podcast", json={"base_revision": 1, "voice_id": "Ethan"}
        )
    assert response.status_code == 200
    assert update.call_args.kwargs["user_id"] == "test-user-001"
    assert update.call_args.kwargs["body"].voice_id == "Ethan"


@pytest.mark.parametrize(
    "path,payload",
    [
        ("export/markdown", None),
        ("export/html", None),
        ("publish/wechat-draft", {}),
    ],
)
def test_existing_delivery_routes_cannot_export_a_podcast_script_as_audio(client, path, payload):
    with patch("pkg.api.assets.get_asset", new=AsyncMock(return_value=make_asset())):
        response = client.post(f"/assets/episode/{path}", json=payload)
    assert response.status_code == 409
    assert "accepted audio render" in response.json()["detail"]
