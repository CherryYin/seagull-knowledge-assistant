import { request } from "./client";

export interface Source {
  id: string;
  title: string;
  category_id: number;
  category_name?: string | null;
  source_type: string;
  url?: string | null;
  content_hash?: string | null;
  description?: string | null;
  raw_content?: string | null;
  file_path?: string | null;
  ingested_at: string;
  metadata_?: Record<string, unknown> | null;
}

export interface SourceList {
  items: Source[];
  total: number;
}

export interface SourceUploadResult extends Source {
  created: boolean;
  duplicate: boolean;
}

export interface SourceCreate {
  title: string;
  category_id: number;
  source_type: string;
  url?: string;
  description?: string;
  raw_content?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceChunk {
  id: number;
  source_id: string;
  chunk_index: number;
  content: string;
}

export interface SourceUpdate {
  title?: string;
  category_id?: number;
  source_type?: string;
  url?: string | null;
  description?: string | null;
  raw_content?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SourceDescriptionProposal {
  description: string;
  model: string;
  basis_content_hash?: string | null;
  generated_at: string;
}

export interface SourceFileAccess {
  url: string;
  expires_in_seconds?: number | null;
}

export const sourcesApi = {
  list: (params?: { source_type?: string; category_id?: number; kind?: string; feed_view?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.source_type) q.set("source_type", params.source_type);
    if (params?.category_id) q.set("category_id", String(params.category_id));
    if (params?.kind) q.set("kind", params.kind);
    if (params?.feed_view) q.set("feed_view", params.feed_view);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<SourceList>(`/sources?${q}`);
  },
  get: (id: string) => request<Source>(`/sources/${encodeURIComponent(id)}`),
  chunks: (id: string) => request<SourceChunk[]>(`/sources/${encodeURIComponent(id)}/chunks`),
  chunkCount: (id: string) => request<{ count: number }>(`/sources/${encodeURIComponent(id)}/chunk-count`),
  create: (body: SourceCreate) =>
    request<Source>("/sources", { method: "POST", body: JSON.stringify(body) }),
  upload: (body: FormData) =>
    request<SourceUploadResult>("/sources/upload", { method: "POST", body }),
  update: (id: string, body: SourceUpdate) =>
    request<Source>(`/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  downloadPdf: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/download-pdf`, { method: "POST" }),
  retryExtraction: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/retry-extraction`, { method: "POST" }),
  generateDescription: (id: string) =>
    request<SourceDescriptionProposal>(`/sources/${encodeURIComponent(id)}/description/generate`, { method: "POST" }),
  fileUrl: (id: string) =>
    request<SourceFileAccess>(`/sources/${encodeURIComponent(id)}/file-url`),
  delete: (id: string) =>
    request<void>(`/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  keepImported: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/review/keep`, { method: "POST" }),
  enableRss: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/rss/enable`, { method: "POST" }),
  disableRss: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/rss/disable`, { method: "POST" }),
  fetchFeed: (id: string) =>
    request<{ new_articles: number }>(`/sources/${encodeURIComponent(id)}/rss/fetch`, { method: "POST" }),
  discoverWebArticles: (id: string, params?: { limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    return request<{ discovered: number; imported: number; updated: number; skipped: number }>(`/sources/${encodeURIComponent(id)}/web/discover?${q}`, { method: "POST" });
  },
  listArticles: (id: string, params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<SourceList>(`/sources/${encodeURIComponent(id)}/articles?${q}`);
  },
};
