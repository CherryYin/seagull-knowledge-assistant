import { request } from "./client";
import type { DiscoveryItemList } from "./discovery";

export interface PaperDiscoveryProfile {
  id: number;
  user_id: string;
  name: string;
  description?: string | null;
  goal_prompt?: string | null;
  mode: "query" | "trend" | "hybrid";
  provider: string;
  schedule: "manual" | "daily" | "weekly";
  is_enabled: boolean;
  max_results: number;
  discovery_window_days: number;
  time_window_days?: number | null;
  include_terms: string[];
  exclude_terms: string[];
  preferred_authors: string[];
  preferred_venues: string[];
  preferred_fields: string[];
  preferred_arxiv_categories: string[];
  seed_paper_ids: string[];
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaperDiscoveryProfileList {
  items: PaperDiscoveryProfile[];
  total: number;
}

export interface PaperDiscoveryRun {
  id: number;
  profile_id: number;
  user_id: string;
  mode: string;
  status: string;
  query_bundle?: Record<string, unknown> | null;
  stats?: Record<string, unknown> | null;
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
}

export const paperDiscoveryApi = {
  listProfiles: () => request<PaperDiscoveryProfileList>("/paper-discovery/profiles"),
  createProfile: (body: Partial<PaperDiscoveryProfile> & { name: string }) =>
    request<PaperDiscoveryProfile>("/paper-discovery/profiles", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  runProfile: (profileId: number, body?: { mode?: "query" | "trend" | "hybrid"; limit?: number }) =>
    request<PaperDiscoveryRun>(`/paper-discovery/profiles/${profileId}/run`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  listCandidates: (profileId: number, limit = 20) =>
    request<DiscoveryItemList>(`/paper-discovery/profiles/${profileId}/candidates?limit=${limit}`),
};
