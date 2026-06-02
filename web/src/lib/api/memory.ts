import { request } from "./client";

export interface MemoryNode {
  id: string;
  node_type: string;
  scope_id: string;
  level: string;
  title: string;
  summary?: string | null;
  content: string;
  child_node_ids: string[];
  derived_from_notes: string[];
  derived_from_sources: string[];
  derived_from_chunks: number[];
  metadata_?: Record<string, unknown> | null;
  confidence_score?: number | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryNodeList {
  items: MemoryNode[];
  total: number;
}

export interface MemoryEdge {
  id: number;
  user_id: string;
  from_node_id: string;
  to_kind: string;
  to_id: string;
  edge_type: string;
  weight?: number | null;
  description?: string | null;
  metadata_?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryEdgeList {
  items: MemoryEdge[];
  total: number;
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

export interface TopicMemoryCandidate {
  node: MemoryNode;
  reason: string;
}

export interface TopicMemoryCandidateList {
  items: TopicMemoryCandidate[];
  total: number;
}

export interface MemoryListParams {
  node_type?: string;
  level?: string;
  scope_id?: string;
  q?: string;
  status?: "active" | "archived" | "pending_review" | "rejected" | "merged";
  has_embedding?: boolean;
  stale?: boolean;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryNodeUpdate {
  title?: string;
  summary?: string | null;
  content?: string;
  status?: "active" | "archived" | "rejected" | "merged";
}

export interface TopicMemoryCandidateParams {
  topic: string;
  limit?: number;
}

export interface TopicMemoryCompileRequest {
  topic: string;
  level?: "topic" | "subtopic";
  source_node_ids?: string[];
  limit?: number;
}

function toQuery(params: MemoryListParams | TopicMemoryCandidateParams = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const memoryApi = {
  list: (params?: MemoryListParams) => request<MemoryNodeList>(`/memory${toQuery(params)}`),
  get: (id: string) => request<MemoryNode>(`/memory/${encodeURIComponent(id)}`),
  update: (id: string, body: MemoryNodeUpdate) =>
    request<MemoryNode>(`/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  edges: (id: string, params?: { direction?: "in" | "out" | "both"; limit?: number; refresh?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.direction) q.set("direction", params.direction);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.refresh !== undefined) q.set("refresh", String(params.refresh));
    return request<MemoryEdgeList>(`/memory/${encodeURIComponent(id)}/edges?${q}`);
  },
  graph: (id: string, params?: { limit?: number; refresh?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.refresh !== undefined) q.set("refresh", String(params.refresh));
    return request<MemoryGraph>(`/memory/${encodeURIComponent(id)}/graph?${q}`);
  },
  topicCandidates: (params: TopicMemoryCandidateParams) =>
    request<TopicMemoryCandidateList>(`/memory/topics/candidates${toQuery(params)}`),
  compileTopic: (body: TopicMemoryCompileRequest) =>
    request<MemoryNode>("/memory/topics/compile", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  merge: (id: string, body: { target_node_id: string; archive_source?: boolean }) =>
    request<MemoryNode>(`/memory/${encodeURIComponent(id)}/merge`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
