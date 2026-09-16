import { request } from "./client";

export interface SearchResult {
  id: string;
  title: string;
  type: string;
  layer?: string | null;
  score: number;
  abstract?: string | null;
  content_preview?: string | null;
  source_type?: string | null;
  match_reason?: string | null;
  highlights?: string[] | null;
  thumbnail_url?: string | null;
  segment_id?: number | null;
  start_ms?: number | null;
  end_ms?: number | null;
  playback_url?: string | null;
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
