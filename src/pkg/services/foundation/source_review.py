from collections.abc import Mapping


IMPORTED_REVIEWABLE = "imported_reviewable"
REVIEWED_KEPT = "reviewed_kept"


def merge_import_metadata(
    existing_metadata: Mapping[str, object] | None,
    imported_metadata: Mapping[str, object] | None,
) -> dict:
    existing = dict(existing_metadata or {})
    merged = {**existing, **dict(imported_metadata or {})}
    if existing.get("review_status") == REVIEWED_KEPT:
        merged["review_status"] = REVIEWED_KEPT
        for key in ("reviewed_at", "kept_at"):
            if existing.get(key):
                merged[key] = existing[key]
    return merged


def mark_explicitly_saved(metadata: Mapping[str, object] | None, *, saved_at: str) -> dict:
    result = dict(metadata or {})
    result["review_status"] = REVIEWED_KEPT
    result["reviewed_at"] = saved_at
    result.setdefault("kept_at", saved_at)
    result["retention"] = "permanent"
    return result
