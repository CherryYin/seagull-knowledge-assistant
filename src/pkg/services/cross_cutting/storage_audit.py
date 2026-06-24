from sqlalchemy import select

from pkg.db import async_session
from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.services.cross_cutting.storage import get_storage_service


def _normalize_minio_uri(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not value.startswith("minio://"):
        return None
    return value


async def collect_referenced_object_uris() -> set[str]:
    referenced: set[str] = set()
    async with async_session() as session:
        for model in (Source, Note):
            rows = await session.execute(select(model.file_path).where(model.file_path.is_not(None)))
            for value in rows.scalars():
                normalized = _normalize_minio_uri(value)
                if normalized:
                    referenced.add(normalized)

        asset_rows = await session.execute(select(Asset.metadata_).where(Asset.metadata_.is_not(None)))
        for metadata in asset_rows.scalars():
            if not isinstance(metadata, dict):
                continue
            for key in ("storage_uri", "file_path", "export_storage_uri"):
                normalized = _normalize_minio_uri(metadata.get(key))
                if normalized:
                    referenced.add(normalized)
    return referenced


async def run_storage_orphan_audit_step() -> dict:
    storage = get_storage_service()
    referenced = await collect_referenced_object_uris()
    object_uris = set(await storage.list_object_uris())
    orphan_uris = sorted(object_uris - referenced)
    return {
        "referenced_count": len(referenced),
        "object_count": len(object_uris),
        "orphan_count": len(orphan_uris),
        "orphan_samples": orphan_uris[:20],
        "delete_enabled": False,
        "reason": None if orphan_uris else "no_orphan_objects",
    }
