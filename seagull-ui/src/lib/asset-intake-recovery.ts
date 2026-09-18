import type { Asset, AssetIntent, AssetIntentRevisionRequest, AssetWorkspace } from "@/lib/api/assets";
import type { AssetIntentFormDraft } from "@/lib/asset-generation";

const STORAGE_KEY = "seagull.asset-intake.recovery.v1";

export type AssetIntakeRecovery = {
  version: 1;
  operationId: string;
  assetId?: string;
  form: AssetIntentFormDraft;
  updatedAt: string;
};

export function createAssetIntakeOperationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `asset-intake-${crypto.randomUUID()}`
    : `asset-intake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readAssetIntakeRecovery(): AssetIntakeRecovery | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const recovery = JSON.parse(raw) as Partial<AssetIntakeRecovery>;
    if (recovery.version !== 1 || typeof recovery.operationId !== "string" || !recovery.form) return null;
    return recovery as AssetIntakeRecovery;
  } catch {
    return null;
  }
}

export function writeAssetIntakeRecovery(recovery: Omit<AssetIntakeRecovery, "version" | "updatedAt">) {
  const stored: AssetIntakeRecovery = {
    ...recovery,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  return stored;
}

export function clearAssetIntakeRecovery() {
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function findAssetForIntakeOperation(items: Asset[], operationId: string) {
  return items.find((asset) => {
    const metadata = asset.metadata_;
    return metadata && metadata.intake_operation_id === operationId;
  }) ?? null;
}

export function intentMatchesDraft(intent: AssetIntent | null | undefined, draft: AssetIntentRevisionRequest) {
  if (!intent) return false;
  return intent.question === draft.question
    && intent.goal === draft.goal
    && (intent.audience ?? null) === (draft.audience ?? null)
    && intent.creation_mode === draft.creation_mode
    && JSON.stringify(intent.scope) === JSON.stringify(draft.scope)
    && JSON.stringify(intent.constraints) === JSON.stringify(draft.constraints);
}

export function hasCurrentEvidenceTarget(
  workspace: AssetWorkspace,
  proposal: { target_type: string; target_id: string },
) {
  const intentRevision = workspace.intent?.revision;
  return workspace.evidence.some((item) => (
    item.intent_revision === intentRevision
    && item.target_type === proposal.target_type
    && item.target_id === proposal.target_id
    && item.status !== "rejected"
    && item.status !== "stale"
  ));
}
