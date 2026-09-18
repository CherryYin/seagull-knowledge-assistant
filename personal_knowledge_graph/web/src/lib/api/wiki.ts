import { request } from "./client";

export interface WikiPage {
  id: string;
  title: string;
  page_type: string;
  summary?: string | null;
  content: string;
  domains: string[];
  tags: string[];
  derived_from_notes: string[];
  derived_from_sources: string[];
  open_questions: string[];
  confidence_score?: number | null;
  needs_recompile: boolean;
  stale_reason?: string | null;
  stale_triggered_at?: string | null;
  last_compiled_at?: string | null;
  metadata_?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WikiPageList {
  items: WikiPage[];
  total: number;
}

export interface WikiPageCreate {
  id?: string;
  title: string;
  page_type?: string;
  summary?: string | null;
  content?: string;
  domains?: string[];
  tags?: string[];
  derived_from_notes?: string[];
  derived_from_sources?: string[];
  open_questions?: string[];
  confidence_score?: number | null;
}

export interface WikiPageUpdate {
  title?: string;
  page_type?: string;
  summary?: string | null;
  content?: string;
  domains?: string[];
  tags?: string[];
  derived_from_notes?: string[];
  derived_from_sources?: string[];
  open_questions?: string[];
  confidence_score?: number | null;
  needs_recompile?: boolean;
  stale_reason?: string | null;
}

export interface WikiRecompileSuggestion {
  id: number;
  user_id: string;
  wiki_id: string;
  wiki_title?: string | null;
  trigger_type: string;
  trigger_id: string;
  reason: string;
  evidence_preview?: string | null;
  status: "pending" | "accepted" | "rejected" | "dismissed" | "applied" | string;
  metadata_?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  applied_at?: string | null;
  reviewer_note?: string | null;
}

export interface WikiCloneDraftRequest {
  title?: string;
}

export interface WikiRecompileSuggestionList {
  items: WikiRecompileSuggestion[];
  total: number;
}

export interface WikiSuggestRequest {
  trigger_type: "source" | "note";
  trigger_id: string;
  limit?: number;
}

export interface WikiEvidenceRef {
  ref_type: string;
  ref_id: string;
  title: string;
  excerpt?: string | null;
}

export interface ReferenceResolveInput {
  ref_type?: string;
  ref_id?: string;
  type?: string;
  id?: string;
  title?: string;
  excerpt?: string | null;
}

export interface ReferenceRead {
  ref_type: string;
  ref_id: string;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  excerpt?: string | null;
  status?: string | null;
  metadata_?: Record<string, unknown> | null;
}

export const wikiApi = {
  list: (params?: {
    page_type?: string;
    domain?: string;
    tag?: string;
    needs_recompile?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.page_type) q.set("page_type", params.page_type);
    if (params?.domain) q.set("domain", params.domain);
    if (params?.tag) q.set("tag", params.tag);
    if (params?.needs_recompile !== undefined) q.set("needs_recompile", String(params.needs_recompile));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<WikiPageList>(`/wiki?${q}`);
  },
  get: (id: string) => request<WikiPage>(`/wiki/${encodeURIComponent(id)}`),
  create: (body: WikiPageCreate) =>
    request<WikiPage>("/wiki", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: WikiPageUpdate) =>
    request<WikiPage>(`/wiki/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  cloneDraft: (id: string, body?: WikiCloneDraftRequest) =>
    request<WikiPage>(`/wiki/${encodeURIComponent(id)}/clone-draft`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  delete: (id: string) =>
    request<void>(`/wiki/${encodeURIComponent(id)}`, { method: "DELETE" }),
  suggestions: (params?: { status?: string; wiki_id?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.status !== undefined) q.set("status", params.status);
    if (params?.wiki_id) q.set("wiki_id", params.wiki_id);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<WikiRecompileSuggestionList>(`/wiki/suggestions?${q}`);
  },
  suggest: (body: WikiSuggestRequest) =>
    request<WikiRecompileSuggestion[]>("/wiki/suggestions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSuggestion: (id: number, status: "pending" | "accepted" | "rejected" | "dismissed" | "applied", reviewer_note?: string | null) =>
    request<WikiRecompileSuggestion>(`/wiki/suggestions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, reviewer_note }),
    }),
  resolveReferences: (refs: ReferenceResolveInput[]) =>
    request<{ items: ReferenceRead[] }>("/wiki/references/resolve", {
      method: "POST",
      body: JSON.stringify({ refs }),
    }),
};
