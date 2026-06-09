import { request } from "./client";
import type { Source } from "./sources";

export type DiscoveryStatus = "recommended" | "kept" | "saved" | "dismissed";
export type DiscoveryProvider = "arxiv" | "github" | "rss" | "web" | "openalex" | "crossref" | "semantic_scholar";

export interface DiscoveryItem {
  id: number;
  user_id: string;
  provider: DiscoveryProvider;
  item_key: string;
  title: string;
  url?: string | null;
  summary?: string | null;
  payload: Record<string, unknown>;
  status: DiscoveryStatus;
  score?: number | null;
  why?: string[] | null;
  source_id?: string | null;
  feedback?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
}

export interface DiscoveryItemList {
  items: DiscoveryItem[];
  total: number;
}

export interface DiscoveryWebResult {
  title: string;
  url: string;
  summary?: string | null;
  source_name?: string | null;
  published_at?: string | null;
}

export const discoveryApi = {
  list: (params?: { provider?: DiscoveryProvider; status?: DiscoveryStatus; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.provider) q.set("provider", params.provider);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<DiscoveryItemList>(`/discovery?${q}`);
  },
  generate: (body?: { providers?: DiscoveryProvider[]; limit?: number }) =>
    request<{ created: number; updated: number; skipped: number }>("/discovery/generate", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  ingestWebResults: (body: { query: string; items: DiscoveryWebResult[] }) =>
    request<{ created: number; updated: number; skipped: number }>("/discovery/web-results", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  searchWeb: (body: { query: string; max_results?: number }) =>
    request<{ created: number; updated: number; skipped: number }>("/discovery/web-search", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  feedback: (id: number, action: "keep" | "save" | "dismiss", note?: string | null) =>
    request<{ item: DiscoveryItem; source?: Source | null; created?: boolean | null }>(`/discovery/${id}/feedback`, {
      method: "PATCH",
      body: JSON.stringify({ action, note }),
    }),
};
