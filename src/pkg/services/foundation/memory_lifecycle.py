from __future__ import annotations

from pkg.models.foundation.memory import MemoryNode

ACTIVE_MEMORY_STATUS = "active"
TERMINAL_MEMORY_STATUSES = {"archived", "rejected", "merged"}
REVIEWABLE_MEMORY_STATUSES = {"pending_review"}
ALL_MEMORY_STATUSES = {ACTIVE_MEMORY_STATUS, *TERMINAL_MEMORY_STATUSES, *REVIEWABLE_MEMORY_STATUSES}


def get_memory_status(node: MemoryNode) -> str:
    metadata = node.metadata_ or {}
    status = metadata.get("status") if isinstance(metadata, dict) else None
    if isinstance(status, str) and status in ALL_MEMORY_STATUSES:
        return status
    return ACTIVE_MEMORY_STATUS


def set_memory_status(node: MemoryNode, status: str) -> None:
    if status not in ALL_MEMORY_STATUSES:
        raise ValueError(f"Unsupported memory status: {status}")
    metadata = dict(node.metadata_ or {})
    if status == ACTIVE_MEMORY_STATUS:
        metadata.pop("status", None)
    else:
        metadata["status"] = status
    node.metadata_ = metadata


def get_memory_usage_count(node: MemoryNode) -> int:
    metadata = node.metadata_ or {}
    value = metadata.get("usage_count") if isinstance(metadata, dict) else None
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def get_memory_last_used_at(node: MemoryNode) -> str | None:
    metadata = node.metadata_ or {}
    value = metadata.get("last_used_at") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def get_memory_last_used_action(node: MemoryNode) -> str | None:
    metadata = node.metadata_ or {}
    value = metadata.get("last_used_action") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def get_memory_last_used_query(node: MemoryNode) -> str | None:
    metadata = node.metadata_ or {}
    value = metadata.get("last_used_query") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def record_memory_use(node: MemoryNode, *, used_at: str, action: str, query: str | None = None) -> None:
    metadata = dict(node.metadata_ or {})
    metadata["last_used_at"] = used_at
    metadata["usage_count"] = get_memory_usage_count(node) + 1
    metadata["last_used_action"] = action
    if query:
        metadata["last_used_query"] = query
    node.metadata_ = metadata


def is_memory_stale(node: MemoryNode) -> bool:
    metadata = node.metadata_ or {}
    value = metadata.get("stale") if isinstance(metadata, dict) else None
    return str(value).lower() == "true"


def get_memory_merged_into(node: MemoryNode) -> str | None:
    metadata = node.metadata_ or {}
    value = metadata.get("merged_into") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def get_memory_merged_from(node: MemoryNode) -> list[str]:
    metadata = node.metadata_ or {}
    value = metadata.get("merged_from") if isinstance(metadata, dict) else None
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item.strip()]
    return []


def mark_memory_merged(source: MemoryNode, *, target_node_id: str) -> None:
    metadata = dict(source.metadata_ or {})
    metadata["merged_into"] = target_node_id
    source.metadata_ = metadata
    set_memory_status(source, "merged")


def record_memory_merge_target(target: MemoryNode, *, source_node_id: str) -> None:
    metadata = dict(target.metadata_ or {})
    existing = metadata.get("merged_from") if isinstance(metadata.get("merged_from"), list) else []
    merged_from = [item for item in existing if isinstance(item, str) and item.strip()]
    if source_node_id not in merged_from:
        merged_from.append(source_node_id)
    metadata["merged_from"] = merged_from
    target.metadata_ = metadata
