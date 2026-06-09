from __future__ import annotations

from pkg.models.foundation.memory import MemoryNode


def get_memory_family(node: MemoryNode) -> str:
    if node.node_type == "topic":
        return "knowledge"
    if node.node_type == "source":
        return "knowledge"
    if node.node_type == "global" and node.level in {"conversation", "day", "digest", "document"}:
        return "operational"
    if node.node_type == "global":
        return "knowledge"
    return "knowledge"


def get_memory_role(node: MemoryNode) -> str:
    if node.node_type == "source" and node.level == "source":
        return "source-memory"
    if node.node_type == "source" and node.level == "batch":
        return "source-batch-memory"
    if node.node_type == "topic":
        return "topic-memory"
    if node.node_type == "global" and node.level == "conversation":
        return "conversation-memory"
    if node.node_type == "global" and node.level == "day":
        return "daily-memory"
    if node.node_type == "global" and node.level == "digest":
        return "digest-memory"
    if node.node_type == "source" and node.level == "document":
        return "document-memory"
    return f"{node.node_type}-{node.level}"
