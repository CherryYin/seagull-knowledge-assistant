import type { MemoryNode } from "@/lib/api";
import { getReviewStatusLabel } from "@/lib/reviewStatus";

export function getMemoryStatus(node: MemoryNode): string {
  const status = node.metadata_?.status;
  return typeof status === "string" && status.length > 0 ? status : "active";
}

export function getMemoryStatusLabel(node: MemoryNode): string {
  return getReviewStatusLabel(getMemoryStatus(node));
}

export function getMemoryUsageCount(node: MemoryNode): number {
  const value = node.metadata_?.usage_count;
  return typeof value === "number" ? value : Number(value || 0) || 0;
}

export function getMemoryLastUsedAt(node: MemoryNode): string | null {
  const value = node.metadata_?.last_used_at;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getMemoryLastUsedAction(node: MemoryNode): string | null {
  const value = node.metadata_?.last_used_action;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isMemoryStale(node: MemoryNode): boolean {
  return String(node.metadata_?.stale || "").toLowerCase() === "true";
}

export function getMemoryMergedInto(node: MemoryNode): string | null {
  const value = node.metadata_?.merged_into;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getMemoryMergedFrom(node: MemoryNode): string[] {
  const value = node.metadata_?.merged_from;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
