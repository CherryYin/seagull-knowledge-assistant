import { request } from "./client";

export type ReviewSuggestionType = "profile_update";
export type ReviewSuggestionStatus = "pending" | "accepted" | "rejected" | "dismissed" | "applied";

export interface ReviewSuggestion {
  id: number;
  user_id: string;
  suggestion_type: ReviewSuggestionType;
  target_type: string;
  target_id: string;
  title: string;
  summary?: string | null;
  proposed_value?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
  status: ReviewSuggestionStatus;
  metadata_?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  applied_at?: string | null;
  reviewer_note?: string | null;
}

// General review suggestions are distinct from wiki refresh reminders for now.
// The product UI treats both as part of the broader Review surface.

export interface ReviewSuggestionList {
  items: ReviewSuggestion[];
  total: number;
}

export const reviewApi = {
  suggestions: (params?: { suggestion_type?: ReviewSuggestionType; status?: ReviewSuggestionStatus; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.suggestion_type) q.set("suggestion_type", params.suggestion_type);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<ReviewSuggestionList>(`/review/suggestions?${q}`);
  },
  generateSuggestions: (body?: { include_profile_suggestions?: boolean; limit?: number }) =>
    request<{ created: number; skipped: number }>("/review/suggestions/generate", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  updateSuggestion: (id: number, status: ReviewSuggestionStatus, reviewer_note?: string | null) =>
    request<ReviewSuggestion>(`/review/suggestions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, reviewer_note }),
    }),
};
