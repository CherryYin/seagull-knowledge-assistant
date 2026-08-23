import type { AssetGenerationRequest } from "@/lib/asset-generation";
import { request } from "./client";

export interface AssetGenerationSessionContext {
  userId?: string;
  sessionId?: string;
  kind: "asset_generation";
  workflowId: "draft-asset";
  assetDraft: AssetGenerationRequest;
  updatedAt?: string;
}

interface SessionContextResponse {
  context: AssetGenerationSessionContext | null;
}

export const sessionContextsApi = {
  get: (sessionId: string) =>
    request<SessionContextResponse>(`/harness/session-contexts/${encodeURIComponent(sessionId)}`),
  putAssetGeneration: (sessionId: string, assetDraft: AssetGenerationRequest) =>
    request<SessionContextResponse>(`/harness/session-contexts/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      body: JSON.stringify({ kind: "asset_generation", assetDraft }),
    }),
  delete: (sessionId: string) =>
    request<void>(`/harness/session-contexts/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
};
