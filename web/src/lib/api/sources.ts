import { request } from "./client";

export interface Source {
  id: string;
  title: string;
  category_id: number;
  category_name?: string | null;
  source_type: string;
  url?: string | null;
  content_hash?: string | null;
  raw_content?: string | null;
  file_path?: string | null;
  ingested_at: string;
  metadata_?: Record<string, unknown> | null;
}

export interface SourceList {
  items: Source[];
  total: number;
}

export interface SourceCreate {
  title: string;
  category_id: number;
  source_type: string;
  url?: string;
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
  metadata?: Record<string, unknown> | null;
}

export interface SourceMedia {
  source_id: string;
  mime_type?: string | null;
  file_size?: number | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
  caption?: string | null;
  caption_model?: string | null;
  processing_status: string;
  processing_version: number;
  processing_attempts: number;
  next_retry_at?: string | null;
  error_message?: string | null;
  processed_at?: string | null;
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
  create: (body: SourceCreate) =>
    request<Source>("/sources", { method: "POST", body: JSON.stringify(body) }),
  upload: (body: FormData) =>
    request<Source>("/sources/upload", { method: "POST", body }),
  update: (id: string, body: SourceUpdate) =>
    request<Source>(`/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  downloadPdf: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/download-pdf`, { method: "POST" }),
  retryExtraction: (id: string) =>
    request<Source>(`/sources/${encodeURIComponent(id)}/retry-extraction`, { method: "POST" }),
  media: (id: string) => request<SourceMedia>(`/sources/${encodeURIComponent(id)}/media`),
  processMedia: (id: string) =>
    request<SourceMedia>(`/sources/${encodeURIComponent(id)}/media/process`, { method: "POST" }),
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
