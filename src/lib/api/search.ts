import { request } from "./client";

export interface SearchResult {
  id: string;
  title: string;
  type: string;
  layer?: string | null;
  score: number;
  abstract?: string | null;
  content_preview?: string | null;
  match_reason?: string | null;
  highlights?: string[] | null;
}

export interface SearchRequest {
  query: string;
  mode?: string;
  top_k?: number;
  filters?: Record<string, unknown>;
}

export const searchApi = {
  search: (body: SearchRequest) =>
    request<SearchResult[]>("/search", { method: "POST", body: JSON.stringify(body) }),
};
