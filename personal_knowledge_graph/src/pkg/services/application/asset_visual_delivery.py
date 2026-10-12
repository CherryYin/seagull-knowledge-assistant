import base64
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset, AssetVisual
from pkg.services.cross_cutting.storage import get_storage_service

VISUAL_DELIVERY_SNAPSHOT_KEY = "visual_delivery_snapshot"


async def resolve_accepted_visuals(
    session: AsyncSession,
    *,
    asset: Asset,
    roles: tuple[str, ...] = ("cover",),
    include_data_url: bool = False,
) -> dict[str, dict[str, Any]]:
    accepted = (asset.metadata_ or {}).get("accepted_visuals")
    if not isinstance(accepted, dict):
        return {}

    resolved: dict[str, dict[str, Any]] = {}
    storage = get_storage_service()
    visual_refs: list[tuple[str, str]] = []
    for role in roles:
        accepted_value = accepted.get(role)
        if role == "inline_illustration" and isinstance(accepted_value, dict):
            for visual_id in dict.fromkeys(str(item) for item in accepted_value.values() if isinstance(item, str)):
                visual_refs.append((f"inline_illustration:{visual_id}", visual_id))
        elif isinstance(accepted_value, str) and accepted_value:
            visual_refs.append((role, accepted_value))

    for result_key, visual_id in visual_refs:
        visual = await session.get(AssetVisual, visual_id)
        if (
            visual is None
            or visual.asset_id != asset.id
            or visual.user_id != asset.user_id
            or visual.status != "accepted"
            or not visual.file_path
        ):
            continue
        metadata = visual.metadata_ or {}
        item = {
            "visual_id": visual.id,
            "role": visual.role,
            "file_path": visual.file_path,
            "image_url": await storage.generate_download_url(visual.file_path),
            "alt_text": str(metadata.get("alt_text") or "").strip(),
            "model": visual.model,
            "width": visual.width,
            "height": visual.height,
            "mime_type": visual.mime_type,
            "parent_visual_id": metadata.get("parent_visual_id"),
            "source_block_ids": [
                str(item) for item in metadata.get("source_block_ids", []) if isinstance(item, str)
            ],
            "download_name": metadata.get("download_name"),
        }
        if include_data_url:
            payload = await storage.get_object(visual.file_path)
            mime_type = visual.mime_type or "image/png"
            item["data_url"] = f"data:{mime_type};base64,{base64.b64encode(payload).decode('ascii')}"
        resolved[result_key] = item
    return resolved


def record_visual_delivery_snapshot(
    metadata: dict | None,
    *,
    delivery: str,
    visuals: dict[str, dict[str, Any]],
    captured_at: datetime | None = None,
) -> dict:
    updated = deepcopy(metadata or {})
    if not visuals:
        return updated

    timestamp = (captured_at or datetime.now(timezone.utc)).isoformat()
    snapshot = updated.get(VISUAL_DELIVERY_SNAPSHOT_KEY)
    if not isinstance(snapshot, dict):
        snapshot = {}
    references = snapshot.get("references")
    if not isinstance(references, dict):
        references = {}
    latest = snapshot.get("latest")
    if not isinstance(latest, dict):
        latest = {}

    role_visual_ids: dict[str, str] = {}
    for role, visual in visuals.items():
        visual_id = str(visual.get("visual_id") or "").strip()
        if not visual_id:
            continue
        role_visual_ids[role] = visual_id
        existing = references.get(visual_id)
        existing = existing if isinstance(existing, dict) else {}
        deliveries = existing.get("deliveries")
        delivery_names = [str(item) for item in deliveries] if isinstance(deliveries, list) else []
        if delivery not in delivery_names:
            delivery_names.append(delivery)
        references[visual_id] = {
            "role": visual.get("role") or role,
            "file_path": visual.get("file_path"),
            "alt_text": visual.get("alt_text") or "",
            "model": visual.get("model"),
            "width": visual.get("width"),
            "height": visual.get("height"),
            "mime_type": visual.get("mime_type"),
            "parent_visual_id": visual.get("parent_visual_id"),
            "source_block_ids": visual.get("source_block_ids") or [],
            "download_name": visual.get("download_name"),
            "first_captured_at": existing.get("first_captured_at") or timestamp,
            "last_captured_at": timestamp,
            "deliveries": delivery_names,
        }

    latest[delivery] = {"captured_at": timestamp, "visual_ids": role_visual_ids}
    snapshot["references"] = references
    snapshot["latest"] = latest
    updated[VISUAL_DELIVERY_SNAPSHOT_KEY] = snapshot
    return updated


def is_visual_in_delivery_snapshot(metadata: dict | None, *, visual_id: str) -> bool:
    snapshot = (metadata or {}).get(VISUAL_DELIVERY_SNAPSHOT_KEY)
    if not isinstance(snapshot, dict):
        return False
    references = snapshot.get("references")
    return isinstance(references, dict) and visual_id in references
