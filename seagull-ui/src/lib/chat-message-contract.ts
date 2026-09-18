import type {
  ChatMessageObjectRef,
  ChatMessageRunContract,
  ChatMessageRunStatus,
  ChatMessageSaveReceipt,
  MessageMetadata,
} from "@/lib/api";
import type { AgentWorkflowContext, WorkflowResultSaveTarget } from "@/lib/agent-workflows";
import type { AssetGenerationRequest } from "@/lib/asset-generation";

export function snapshotObjectRef(objectRef?: AgentWorkflowContext["objectRef"]): ChatMessageObjectRef | undefined {
  return objectRef ? { ...objectRef } : undefined;
}

export function snapshotAssetDraft(assetDraft?: AssetGenerationRequest) {
  if (!assetDraft) return undefined;
  return JSON.parse(JSON.stringify(assetDraft)) as Record<string, unknown>;
}

export function createChatRunContract({
  workflowId,
  objectRef,
  saveTargets,
  assetDraft,
}: {
  workflowId?: string | null;
  objectRef?: AgentWorkflowContext["objectRef"];
  saveTargets: WorkflowResultSaveTarget[];
  assetDraft?: AssetGenerationRequest;
}): ChatMessageRunContract {
  return {
    version: 1,
    workflow_id: workflowId ?? null,
    object_ref: snapshotObjectRef(objectRef),
    run_status: "running",
    save_targets: [...saveTargets],
    result_validated: false,
    asset_draft: snapshotAssetDraft(assetDraft),
    started_at: new Date().toISOString(),
  };
}

export function completeChatRunContract(
  contract: ChatMessageRunContract,
  status: ChatMessageRunStatus,
  error?: string,
): ChatMessageRunContract {
  return {
    ...contract,
    run_status: status,
    result_validated: status === "completed",
    completed_at: status === "awaiting_input" ? undefined : new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

export function getMessageRunContract(metadata?: MessageMetadata | null) {
  return metadata?.agent_run ?? null;
}

export function getMessageSaveTargets(metadata: MessageMetadata | null | undefined, content: string) {
  const contract = getMessageRunContract(metadata);
  if (contract) {
    return contract.run_status === "completed" && contract.result_validated
      ? contract.save_targets
      : [];
  }
  return /^\s*(Error:|Stopped\.)/i.test(content) ? [] : ["note" as const];
}

export function getMessageAssetDraft(metadata?: MessageMetadata | null) {
  const assetDraft = metadata?.agent_run?.asset_draft;
  return assetDraft as AssetGenerationRequest | undefined;
}

export function createSaveReceipt(
  target: WorkflowResultSaveTarget,
  result: unknown,
): ChatMessageSaveReceipt {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const objectType = target === "asset" ? "asset" : target === "wiki_draft" ? "wiki" : "note";
  return {
    target,
    object_type: objectType,
    object_id: typeof record.id === "string" ? record.id : "saved",
    title: typeof record.title === "string" ? record.title : null,
    saved_at: new Date().toISOString(),
  };
}
