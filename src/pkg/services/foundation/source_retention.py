from typing import Any


PERMANENT_SOURCE_TYPES = frozenset({"pdf", "article"})


def apply_source_retention(source_type: str, metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    if source_type not in PERMANENT_SOURCE_TYPES:
        return metadata

    retained_metadata = dict(metadata or {})
    retained_metadata["retention"] = "permanent"
    return retained_metadata


def is_auto_cleanup_protected(source_type: str) -> bool:
    return source_type in PERMANENT_SOURCE_TYPES
