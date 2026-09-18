import { request } from "./client";

export type AgentMemoryScopeType = "global" | "workspace" | "project" | "agent";
export type AgentMemoryKind = "preference" | "constraint" | "profile" | "project_context";

export interface AgentMemoryProvenance {
  sessionId: string;
  eventIds: string[];
  toolCallIds: string[];
}

export interface AgentMemoryCandidate {
  id: string;
  proposedScopeType: AgentMemoryScopeType;
  proposedScopeId: string | null;
  proposedKind: AgentMemoryKind;
  title: string;
  content: string;
  reason: string;
  provenance: AgentMemoryProvenance;
  status: "pending" | "accepted" | "rejected" | "expired";
  createdAt: string;
  decidedAt: string | null;
}

export interface AgentMemory {
  id: string;
  scopeType: AgentMemoryScopeType;
  scopeId: string | null;
  kind: AgentMemoryKind;
  title: string;
  content: string;
  status: "active" | "archived";
  provenance: AgentMemoryProvenance;
  confirmedAt: string;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface AgentMemoryList {
  candidates: AgentMemoryCandidate[];
  memories: AgentMemory[];
}

export interface AgentMemoryRecallAudit {
  id: string;
  sessionId: string;
  query: string;
  scopeType: AgentMemoryScopeType;
  scopeId: string | null;
  matches: Array<{
    memoryId: string;
    scopeType: AgentMemoryScopeType;
    scopeId: string | null;
    reason: string;
  }>;
  createdAt: string;
}

export const agentMemoryApi = {
  list: () => request<AgentMemoryList>("/harness/memories"),
  listRecallAudits: (sessionId?: string) => request<{ items: AgentMemoryRecallAudit[] }>(
    `/harness/memory-recalls${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
  ),
  propose: (body: {
    proposedScopeType: AgentMemoryScopeType;
    proposedScopeId?: string | null;
    proposedKind: AgentMemoryKind;
    title: string;
    content: string;
    reason: string;
    provenance: AgentMemoryProvenance;
  }) => request<AgentMemoryCandidate>("/harness/memory-candidates", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateCandidate: (id: string, body: Partial<Pick<AgentMemoryCandidate, "title" | "content">>) =>
    request<AgentMemoryCandidate>(`/harness/memory-candidates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  accept: (id: string, body: Partial<Pick<AgentMemory, "title" | "content">> = {}) =>
    request<{ candidate: AgentMemoryCandidate; memory: AgentMemory }>(
      `/harness/memory-candidates/${encodeURIComponent(id)}/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  reject: (id: string) => request<AgentMemoryCandidate>(
    `/harness/memory-candidates/${encodeURIComponent(id)}/reject`,
    { method: "POST" },
  ),
  update: (id: string, body: Partial<Pick<AgentMemory, "title" | "content">>) =>
    request<AgentMemory>(`/harness/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  archive: (id: string) => request<AgentMemory>(`/harness/memories/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  restore: (id: string) => request<AgentMemory>(`/harness/memories/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  delete: (id: string) => request<{ deleted: true; id: string }>(`/harness/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
