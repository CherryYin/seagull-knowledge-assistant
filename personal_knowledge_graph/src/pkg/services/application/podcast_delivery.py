from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.podcast import AssetAudioRender
from pkg.schemas.application.podcast_delivery import PodcastDeliveryList, PodcastDeliveryRead, PodcastDeliveryUpdate
from pkg.services.application.assets import get_asset
from pkg.services.application.production_memory import record_asset_production_event

DELIVERY_METADATA_KEY = "podcast_delivery_v1"


async def _owned_podcast(session, *, user_id, asset_id, writing=False):
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id, for_update=writing)
    if asset.asset_type != "podcast":
        raise HTTPException(status_code=409, detail="Asset is not a podcast")
    if writing and asset.status == "archived":
        raise HTTPException(status_code=409, detail="Archived podcast is read-only")
    return asset


async def list_delivery_records(session: AsyncSession, *, user_id: str, asset_id: str) -> PodcastDeliveryList:
    asset = await _owned_podcast(session, user_id=user_id, asset_id=asset_id)
    return PodcastDeliveryList(items=(asset.metadata_ or {}).get(DELIVERY_METADATA_KEY, []))


async def save_delivery_record(session: AsyncSession, *, user_id: str, asset_id: str, record_id: str, body: PodcastDeliveryUpdate) -> PodcastDeliveryRead:
    asset = await _owned_podcast(session, user_id=user_id, asset_id=asset_id, writing=True)
    records = list((asset.metadata_ or {}).get(DELIVERY_METADATA_KEY, []))
    previous = next((record for record in records if record["id"] == record_id), None)
    if body.base_revision != (previous["revision"] if previous else 0):
        raise HTTPException(status_code=409, detail="Publication record changed; reload records before saving")
    if previous and previous["render_id"] != body.render_id:
        raise HTTPException(status_code=409, detail="An existing record cannot switch audio versions; create another record")
    if previous and previous["confirm_published"] and not body.confirm_published:
        raise HTTPException(status_code=409, detail="Saving information cannot undo confirmed publication")
    if not previous and len(records) >= 200:
        raise HTTPException(status_code=409, detail="Publication record limit reached")
    previous_snapshots = previous.get("statistics_snapshots", []) if previous else []
    snapshots = previous_snapshots if body.statistics_snapshots is None else [snapshot.model_dump(mode="json") for snapshot in body.statistics_snapshots]
    if snapshots[:len(previous_snapshots)] != previous_snapshots or not len(previous_snapshots) <= len(snapshots) <= len(previous_snapshots) + 1:
        raise HTTPException(status_code=409, detail="效果快照只能逐条追加，不能删除或覆盖历史；更正请新增快照并注明原因")
    if previous_snapshots:
        binding = (str(body.publish_url), body.channel, body.published_at)
        previous_binding = (previous["publish_url"], previous["channel"], datetime.fromisoformat(previous["published_at"]))
        if binding != previous_binding:
            raise HTTPException(status_code=409, detail="已有效果快照的文章链接、发布渠道和发布时间不可修改，请新建发布记录")
    render = (await session.execute(select(AssetAudioRender).where(
        AssetAudioRender.id == body.render_id, AssetAudioRender.asset_id == asset_id,
    ))).scalar_one_or_none()
    if render is None:
        raise HTTPException(status_code=404, detail="Audio render not found")
    if render.status != "ready" or not render.file_sha256:
        raise HTTPException(status_code=409, detail="Only completed audio can be recorded")
    now = datetime.now(timezone.utc)
    record = PodcastDeliveryRead(
        **{**body.model_dump(), "statistics_snapshots": snapshots}, id=record_id, revision=body.base_revision + 1,
        script_approval_id=render.script_approval_id, file_sha256=render.file_sha256,
        created_at=previous["created_at"] if previous else now, updated_at=now, recorded_by=user_id,
    )
    metadata = dict(asset.metadata_ or {})
    metadata[DELIVERY_METADATA_KEY] = [record.model_dump(mode="json"), *[item for item in records if item["id"] != record_id]]
    if body.confirm_published:
        asset.status = "published"
        asset.published_at = max(
            datetime.fromisoformat(item["published_at"]) for item in metadata[DELIVERY_METADATA_KEY] if item["confirm_published"]
        )
        latest = next(item for item in metadata[DELIVERY_METADATA_KEY] if item["confirm_published"] and datetime.fromisoformat(item["published_at"]) == asset.published_at)
        metadata["publish_feedback"] = {key: latest[key] for key in ("publish_url", "channel", "published_at", "feedback")}
    asset.metadata_ = metadata
    await record_asset_production_event(
        session, user_id=user_id, asset=asset,
        event_type="asset_published" if body.confirm_published and not (previous and previous["confirm_published"]) else "asset_feedback_recorded",
        detail={"record_id": record_id, "render_id": render.id, "revision": record.revision,
                "published_at": record.published_at.isoformat() if record.published_at else None,
                "statistics_snapshot_count": len(record.statistics_snapshots),
                "channel": record.channel, "publish_url": str(record.publish_url) if record.publish_url else None},
    )
    await session.commit()
    return record
