import { request } from "./client";
import type { Note } from "./notes";

export interface KnowledgeStatsItem {
  item_id: string;
  item_type: string;
  title: string;
  category_name?: string | null;
  search_count: number;
  retrieval_count: number;
  reference_count: number;
  total_count: number;
  last_accessed_at?: string | null;
}

export interface KnowledgeStatsList {
  items: KnowledgeStatsItem[];
  total: number;
}

export interface SaveDocumentRequest {
  message_content: string;
  title?: string;
  storage_uri?: string;
  document_format?: string;
  document_filename?: string;
  session_id?: string;
  category_id?: number;
}

export interface SaveDocumentResponse {
  source_id: string;
  note_id: string;
}

export interface RememberRequest {
  content: string;
  session_id?: string;
  title?: string;
}

export interface ModelInfo {
  id: string;
  display_name: string;
  provider_id: string;
  provider_name: string;
}

export interface DashboardData {
  counts: {
    notes: number;
    sources: number;
    chats: number;
    digest_pending: number;
  };
  trends: Array<{
    date: string;
    notes: number;
    sources: number;
    chats: number;
  }>;
  category_distribution: Array<{
    name: string;
    display_name: string;
    notes: number;
    sources: number;
  }>;
  note_type_distribution: Array<{
    type: string;
    count: number;
  }>;
}

export const knowledgeApi = {
  models: () => request<ModelInfo[]>("/knowledge/models"),
  dashboard: () => request<DashboardData>("/knowledge/dashboard"),
  saveDocument: (body: SaveDocumentRequest) =>
    request<SaveDocumentResponse>("/knowledge/save-document", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remember: (body: RememberRequest) =>
    request<Note>("/knowledge/remember", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  stats: (params?: {
    sort_by?: string;
    item_type?: string;
    title?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.sort_by) q.set("sort_by", params.sort_by);
    if (params?.item_type) q.set("item_type", params.item_type);
    if (params?.title) q.set("title", params.title);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<KnowledgeStatsList>(`/knowledge/stats?${q}`);
  },
};
