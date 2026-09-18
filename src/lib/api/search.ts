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

export type LibraryEntityType = "source" | "note" | "wiki";
export type LibraryMediaType = "text" | "image" | "video";

export interface LibrarySearchHit {
  field: string;
  reason: string;
  text?: string | null;
}

export interface LibrarySearchResult {
  id: string;
  entity_type: LibraryEntityType;
  result_type: string;
  media_type?: LibraryMediaType | null;
  title: string;
  excerpt?: string | null;
  score: number;
  href: string;
  created_at?: string | null;
  updated_at?: string | null;
  tags: string[];
  lifecycle_status?: string | null;
  category_id?: number | null;
  category_name?: string | null;
  category_label?: string | null;
  source_type?: string | null;
  thumbnail_url?: string | null;
  playback_url?: string | null;
  segment_id?: number | null;
  start_ms?: number | null;
  end_ms?: number | null;
  hit: LibrarySearchHit;
}

export interface LibrarySearchRequest {
  query?: string;
  mode?: string;
  entity_types?: LibraryEntityType[];
  media_types?: LibraryMediaType[];
  lifecycle_statuses?: string[];
  category_ids?: number[];
  tags?: string[];
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export interface LibrarySearchResponse {
  items: LibrarySearchResult[];
  total: number;
  limit: number;
  offset: number;
  facets: Record<string, Record<string, number>>;
}

export interface LibraryFilterOptions {
  categories: Array<{ id: number; name: string; label: string }>;
  tags: string[];
}

export const libraryApi = {
  search: (body: LibrarySearchRequest) =>
    request<LibrarySearchResponse>("/library/search", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  list: () => request<LibrarySearchResponse>("/library"),
  filterOptions: () => request<LibraryFilterOptions>("/library/filter-options"),
};
