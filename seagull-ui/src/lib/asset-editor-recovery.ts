import type { AssetBlock } from "@/lib/asset-blocks";

export interface AssetEditorPendingOptimization {
  round: number;
  workspaceRevision: number;
  instruction: string;
  auditVerdict?: "pass" | "warn" | "block";
  auditScore?: number;
  findingIds: string[];
}

export interface AssetEditorSnapshot {
  title: string;
  brief: string;
  outline: string;
  style: string;
  blocks: AssetBlock[];
  pendingOptimizationRound: AssetEditorPendingOptimization | null;
}

export interface AssetEditorRecovery {
  version: 1;
  assetId: string;
  baseWorkspaceRevision: number;
  baseEditorSignature: string;
  snapshot: AssetEditorSnapshot;
  updatedAt: string;
  expiresAt: string;
}

const RECOVERY_PREFIX = "knowledge-lab:asset-editor-recovery:v1:";
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function isAssetBlock(value: unknown): value is AssetBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  return typeof block.id === "string"
    && typeof block.type === "string"
    && typeof block.markdown === "string"
    && typeof block.revision === "number"
    && Array.isArray(block.claimRefs)
    && block.claimRefs.every((claimId) => typeof claimId === "string");
}

function isPendingOptimization(value: unknown): value is AssetEditorPendingOptimization | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const pending = value as Record<string, unknown>;
  return typeof pending.round === "number"
    && typeof pending.workspaceRevision === "number"
    && typeof pending.instruction === "string"
    && Array.isArray(pending.findingIds)
    && pending.findingIds.every((findingId) => typeof findingId === "string");
}

function isSnapshot(value: unknown): value is AssetEditorSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.title === "string"
    && typeof snapshot.brief === "string"
    && typeof snapshot.outline === "string"
    && typeof snapshot.style === "string"
    && Array.isArray(snapshot.blocks)
    && snapshot.blocks.every(isAssetBlock)
    && isPendingOptimization(snapshot.pendingOptimizationRound);
}

function storageKey(assetId: string) {
  return `${RECOVERY_PREFIX}${assetId}`;
}

export function assetEditorSignature(snapshot: AssetEditorSnapshot) {
  return `editor-${stableHash(JSON.stringify({
    title: snapshot.title,
    brief: snapshot.brief,
    outline: snapshot.outline,
    style: snapshot.style,
    blocks: snapshot.blocks,
  }))}`;
}

export function readAssetEditorRecovery(assetId: string): AssetEditorRecovery | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(assetId));
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    if (
      candidate.version !== 1
      || candidate.assetId !== assetId
      || typeof candidate.baseWorkspaceRevision !== "number"
      || typeof candidate.baseEditorSignature !== "string"
      || typeof candidate.updatedAt !== "string"
      || typeof candidate.expiresAt !== "string"
      || !isSnapshot(candidate.snapshot)
    ) {
      window.sessionStorage.removeItem(storageKey(assetId));
      return null;
    }
    if (Date.parse(candidate.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(storageKey(assetId));
      return null;
    }
    return candidate as unknown as AssetEditorRecovery;
  } catch {
    return null;
  }
}

export function writeAssetEditorRecovery(
  assetId: string,
  baseWorkspaceRevision: number,
  baseEditorSignature: string,
  snapshot: AssetEditorSnapshot,
) {
  const now = new Date();
  const recovery: AssetEditorRecovery = {
    version: 1,
    assetId,
    baseWorkspaceRevision,
    baseEditorSignature,
    snapshot,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RECOVERY_TTL_MS).toISOString(),
  };
  window.sessionStorage.setItem(storageKey(assetId), JSON.stringify(recovery));
  return recovery;
}

export function clearAssetEditorRecovery(assetId: string) {
  try {
    window.sessionStorage.removeItem(storageKey(assetId));
  } catch {
    // Session storage may be unavailable in hardened browser contexts.
  }
}
