import type { MemoryNode } from "@/lib/api";

export function getMemoryFamily(node: MemoryNode): string {
  if (node.node_type === "topic") return "knowledge";
  if (node.node_type === "source") return "knowledge";
  if (node.node_type === "global" && ["conversation", "day", "digest", "document"].includes(node.level)) {
    return "operational";
  }
  if (node.node_type === "global") return "knowledge";
  return "knowledge";
}

export function getMemoryRole(node: MemoryNode): string {
  if (node.node_type === "source" && node.level === "source") return "source-memory";
  if (node.node_type === "source" && node.level === "batch") return "source-batch-memory";
  if (node.node_type === "topic") return "topic-memory";
  if (node.node_type === "global" && node.level === "conversation") return "conversation-memory";
  if (node.node_type === "global" && node.level === "day") return "daily-memory";
  if (node.node_type === "global" && node.level === "digest") return "digest-memory";
  if (node.node_type === "source" && node.level === "document") return "document-memory";
  return `${node.node_type}-${node.level}`;
}
