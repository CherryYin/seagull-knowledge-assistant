from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from pkg.schemas.application.podcast_delivery import PodcastDeliveryUpdate
from pkg.services.application.podcast_delivery import list_delivery_records, save_delivery_record


def payload(**overrides):
    return {"base_revision": 0, "render_id": "ready-audio", "channel": "微信公众号", **overrides}


@pytest.fixture
def delivery_context(mock_session):
    asset = SimpleNamespace(id="episode", asset_type="podcast", status="draft", metadata_={}, published_at=None)
    render = SimpleNamespace(id="ready-audio", status="ready", file_sha256="a" * 64, script_approval_id="frozen-script")
    mock_session.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=render))
    with patch("pkg.services.application.podcast_delivery.get_asset", new=AsyncMock(return_value=asset)) as owned, patch(
        "pkg.services.application.podcast_delivery.record_asset_production_event", new=AsyncMock()
    ) as event:
        yield asset, render, owned, event


async def save(session, **overrides):
    return await save_delivery_record(session, user_id="owner", asset_id="episode", record_id="record-1", body=PodcastDeliveryUpdate(**payload(**overrides)))


@pytest.mark.asyncio
async def test_save_feedback_does_not_publish_or_infer_adoption(mock_session, delivery_context):
    asset, render, owned, event = delivery_context
    record = await save(mock_session, manual_steps=["editing", "editing"], notes="cut intro")
    assert asset.status == "draft"
    assert asset.published_at is None
    assert "publish_feedback" not in asset.metadata_
    assert record.adoption == "undecided"
    assert record.manual_steps == ["editing"]
    assert record.file_sha256 == render.file_sha256
    assert record.script_approval_id == "frozen-script"
    assert record.revision == 1
    assert owned.call_args.kwargs == {"user_id": "owner", "asset_id": "episode", "for_update": True}
    assert event.call_args.kwargs["event_type"] == "asset_feedback_recorded"
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_confirm_publication_and_edit_preserves_other_versions(mock_session, delivery_context):
    asset, render, owned, event = delivery_context
    record = await save(mock_session, confirm_published=True, published_at="2026-01-01T10:00:00+08:00", publish_url="https://mp.weixin.qq.com/s/test")
    assert asset.status == "published"
    assert asset.published_at == datetime(2026, 1, 1, 2, tzinfo=timezone.utc)
    assert asset.metadata_["publish_feedback"]["publish_url"] == str(record.publish_url)
    assert event.call_args.kwargs["event_type"] == "asset_published"
    await save_delivery_record(mock_session, user_id="owner", asset_id="episode", record_id="record-2", body=PodcastDeliveryUpdate(**payload(render_id="second-audio")))
    render.id = "second-audio"
    assert len(asset.metadata_["podcast_delivery_v1"]) == 2
    updated = await save(mock_session, base_revision=1, confirm_published=True, published_at="2026-01-01T10:00:00+08:00", adoption="modified", feedback="Trimmed opening")
    assert updated.revision == 2
    assert len(asset.metadata_["podcast_delivery_v1"]) == 2
    assert asset.metadata_["podcast_delivery_v1"][1]["id"] == "record-2"
    assert event.call_args.kwargs["event_type"] == "asset_feedback_recorded"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["queued", "generating", "failed", "outcome_unknown", "abandoned"])
async def test_only_completed_audio_can_be_recorded(mock_session, delivery_context, status):
    asset, render, owned, event = delivery_context
    render.status = status
    with pytest.raises(HTTPException) as error:
        await save(mock_session)
    assert error.value.status_code == 409
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["foreign", "missing_file", "archived", "not_podcast"])
async def test_ownership_type_and_archive_protection(mock_session, delivery_context, kind):
    asset, render, owned, event = delivery_context
    if kind == "foreign":
        mock_session.execute.return_value.scalar_one_or_none.return_value = None
    elif kind == "missing_file":
        render.file_sha256 = None
    elif kind == "archived":
        asset.status = "archived"
    else:
        asset.asset_type = "blog"
    with pytest.raises(HTTPException) as error:
        await save(mock_session)
    assert error.value.status_code == (404 if kind == "foreign" else 409)
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_conflicts_and_version_binding(mock_session, delivery_context):
    await save(mock_session, confirm_published=True, published_at="2026-01-01T00:00:00Z")
    for overrides in ({}, {"base_revision": 1, "render_id": "different"}, {"base_revision": 1}):
        with pytest.raises(HTTPException) as error:
            await save(mock_session, **overrides)
        assert error.value.status_code == 409
    assert mock_session.commit.await_count == 1


@pytest.mark.asyncio
async def test_archived_records_remain_readable(mock_session, delivery_context):
    asset, render, owned, event = delivery_context
    await save(mock_session)
    asset.status = "archived"
    records = await list_delivery_records(mock_session, user_id="owner", asset_id="episode")
    assert records.items[0].id == "record-1"


@pytest.mark.parametrize("overrides", [
    {"confirm_published": True}, {"confirm_published": True, "published_at": "2099-01-01T00:00:00Z"},
    {"published_at": "2026-01-01T00:00:00"}, {"publish_url": "javascript:alert(1)"},
    {"publish_url": "https://user:secret@example.com"}, {"adoption": "yes"},
    {"manual_steps": ["forged"]}, {"base_revision": -1}, {"channel": " "}, {"recorded_by": "other"},
])
def test_invalid_and_injected_fields_rejected(overrides):
    with pytest.raises(ValidationError):
        PodcastDeliveryUpdate(**payload(**overrides))


def test_delivery_metadata_is_protected_from_generic_updates():
    from pkg.services.application.assets import _preserve_workspace_metadata
    original = {"podcast_delivery_v1": [{"id": "keep"}]}
    assert _preserve_workspace_metadata(original, {})["podcast_delivery_v1"] == original["podcast_delivery_v1"]
    assert "podcast_delivery_v1" not in _preserve_workspace_metadata({}, {"podcast_delivery_v1": ["forged"]})


def test_routes_preserve_authenticated_scope(client, mock_session):
    with patch("pkg.api.assets.list_delivery_records", new=AsyncMock(return_value={"items": []})) as history:
        response = client.get("/assets/episode/podcast/delivery-records")
    assert response.status_code == 200
    assert history.call_args.kwargs == {"user_id": "test-user-001", "asset_id": "episode"}
    with patch("pkg.api.assets.save_delivery_record", new=AsyncMock(side_effect=HTTPException(status_code=409, detail="Publication record changed"))) as write:
        response = client.put("/assets/episode/podcast/delivery-records/record-1", json=payload())
    assert response.status_code == 409
    assert write.call_args.kwargs["user_id"] == "test-user-001"
    assert write.call_args.kwargs["record_id"] == "record-1"
    assert client.put("/assets/episode/podcast/delivery-records/record-1", json=payload(recorded_by="foreign")).status_code == 422


def test_publication_route_serializes_and_reads_saved_records(client, delivery_context):
    asset, render, owned, event = delivery_context
    response = client.put("/assets/episode/podcast/delivery-records/record-1", json=payload(
        confirm_published=True, published_at="2026-01-01T10:00:00+08:00", publish_url="https://mp.weixin.qq.com/s/test",
    ))
    assert response.status_code == 200
    record = response.json()
    assert record["revision"] == 1
    assert record["recorded_by"] == "test-user-001"
    assert record["adoption"] == "undecided"
    assert asset.status == "published"
    history = client.get("/assets/episode/podcast/delivery-records")
    assert history.status_code == 200
    assert history.json()["items"] == [record]


def statistics_snapshot(**overrides):
    return {
        "id": "b3c2693b-043b-4987-aae4-3b4349bce890", "source": "manual_backend",
        "account_label": "海鸥ai应用", "period_kind": "cumulative", "period_start": "2026-01-01",
        "period_end": "2026-01-04", "captured_at": "2026-01-05T00:00:00Z",
        "metrics": {"read": {"value": 42, "unit": "people"}, "share": {"value": 0, "unit": "times"}},
        "notes": "下期缩短开头", "user_confirmed": True, **overrides,
    }


def statistics_payload(**overrides):
    return payload(**{"confirm_published": True, "published_at": "2026-01-01T10:00:00+08:00",
                      "publish_url": "https://mp.weixin.qq.com/s/published", "statistics_snapshots": [statistics_snapshot()], **overrides})


@pytest.mark.asyncio
async def test_statistics_snapshot_binds_to_publication_and_preserves_unknown_and_zero(mock_session, delivery_context):
    asset, render, owned, event = delivery_context
    record = await save(mock_session, **{key: value for key, value in statistics_payload().items() if key not in ("render_id", "channel", "base_revision")})
    snapshot = record.statistics_snapshots[0]
    assert snapshot.metrics["share"].value == 0
    assert "like" not in snapshot.metrics
    assert record.render_id == render.id
    assert record.file_sha256 == render.file_sha256
    assert snapshot.source == "manual_backend"
    assert event.call_args.kwargs["detail"]["statistics_snapshot_count"] == 1
    records = await list_delivery_records(mock_session, user_id="owner", asset_id="episode")
    assert records.items[0].statistics_snapshots == record.statistics_snapshots


@pytest.mark.asyncio
async def test_legacy_client_omission_preserves_snapshots_and_locks_article_binding(mock_session, delivery_context):
    await save_delivery_record(mock_session, user_id="owner", asset_id="episode", record_id="record-1", body=PodcastDeliveryUpdate(**statistics_payload()))
    updated = await save(mock_session, base_revision=1, confirm_published=True, published_at="2026-01-01T10:00:00+08:00", publish_url="https://mp.weixin.qq.com/s/published", feedback="已核对")
    assert len(updated.statistics_snapshots) == 1
    for overrides in [
        {"publish_url": "https://mp.weixin.qq.com/s/other"},
        {"published_at": "2026-01-02T10:00:00+08:00"}, {"channel": "其他渠道"},
    ]:
        body = PodcastDeliveryUpdate(**{**payload(base_revision=2, confirm_published=True, published_at="2026-01-01T10:00:00+08:00", publish_url="https://mp.weixin.qq.com/s/published"), **overrides})
        with pytest.raises(HTTPException) as error:
            await save_delivery_record(mock_session, user_id="owner", asset_id="episode", record_id="record-1", body=body)
        assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_statistics_are_append_only_with_conflicts_and_no_silent_correction(mock_session, delivery_context):
    record = await save_delivery_record(mock_session, user_id="owner", asset_id="episode", record_id="record-1", body=PodcastDeliveryUpdate(**statistics_payload()))
    previous = [snapshot.model_dump(mode="json") for snapshot in record.statistics_snapshots]
    for snapshots in [[], [statistics_snapshot(notes="覆盖历史")], [*previous, statistics_snapshot(id="41b81ffc-ec41-40f6-9850-c8e9be9ce9b3"), statistics_snapshot(id="e742395f-2284-4056-a809-5f3debe33c85")]]:
        body = PodcastDeliveryUpdate(**{**statistics_payload(), "base_revision": 1, "statistics_snapshots": snapshots})
        with pytest.raises(HTTPException) as error:
            await save_delivery_record(mock_session, user_id="owner", asset_id="episode", record_id="record-1", body=body)
        assert error.value.status_code == 409
    correction = statistics_snapshot(id="41b81ffc-ec41-40f6-9850-c8e9be9ce9b3", notes="更正口径，前次误记为人数", metrics={"read": {"value": 42, "unit": "times"}})
    updated = await save_delivery_record(mock_session, user_id="owner", asset_id="episode", record_id="record-1", body=PodcastDeliveryUpdate(**{**statistics_payload(), "base_revision": 1, "statistics_snapshots": [*previous, correction]}))
    assert len(updated.statistics_snapshots) == 2
    assert updated.statistics_snapshots[0].metrics["read"].unit == "people"
    assert updated.statistics_snapshots[1].metrics["read"].unit == "times"
    assert mock_session.commit.await_count == 2


@pytest.mark.parametrize("overrides", [
    {"period_start": "2026-01-05"}, {"period_end": "2026-01-06"}, {"period_start": "2025-12-31"},
    {"period_start": "2026-01-02"}, {"captured_at": "2099-01-01T00:00:00Z"},
    {"captured_at": "2026-01-05T00:00:00"}, {"metrics": {}},
    {"metrics": {"read": {"value": -1, "unit": "people"}}},
    {"metrics": {"read": {"value": True, "unit": "people"}}},
    {"metrics": {"read": {"value": "42", "unit": "people"}}},
    {"metrics": {"read": {"value": 1.2, "unit": "people"}}},
    {"metrics": {"read": {"value": 9007199254740992, "unit": "people"}}},
    {"metrics": {"read": {"value": 42}}}, {"metrics": {"audio_play": {"value": 42, "unit": "times"}}},
    {"account_label": " "}, {"user_confirmed": False}, {"source": "official_api"},
    {"raw_report": {"cookie": "private"}}, {"source": "browser_report"},
    {"metrics": {"read": {"value": 42, "unit": "people", "source_field": "read_num"}}},
])
def test_invalid_statistics_snapshots_are_rejected(overrides):
    with pytest.raises(ValidationError):
        PodcastDeliveryUpdate(**{**statistics_payload(), "statistics_snapshots": [statistics_snapshot(**overrides)]})


def test_browser_mappings_require_explicit_fields_and_preserve_units():
    snapshot = statistics_snapshot(source="browser_report", metrics={"read": {"value": 42, "unit": "times", "source_field": "read_num"}})
    record = PodcastDeliveryUpdate(**{**statistics_payload(), "statistics_snapshots": [snapshot]})
    assert record.statistics_snapshots[0].metrics["read"].source_field == "read_num"
    duplicate = {"read": {"value": 42, "unit": "times", "source_field": "read_num"}, "like": {"value": 42, "unit": "times", "source_field": "read_num"}}
    with pytest.raises(ValidationError):
        PodcastDeliveryUpdate(**{**statistics_payload(), "statistics_snapshots": [statistics_snapshot(source="browser_report", metrics=duplicate)]})


@pytest.mark.parametrize("override", [{"confirm_published": False}, {"publish_url": None}, {"publish_url": "https://example.com/s/article"}, {"publish_url": "https://mp.weixin.qq.com/settings"}])
def test_statistics_cannot_create_unpublished_or_non_wechat_results(override):
    with pytest.raises(ValidationError):
        PodcastDeliveryUpdate(**{**statistics_payload(), **override})
