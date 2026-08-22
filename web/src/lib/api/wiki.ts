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

export interface WikiPageSource {
  id: number;
  wiki_id: string;
  source_id: string;
  relevance_summary: string;
  key_points?: Array<string | Record<string, unknown>> | null;
  supporting_claims?: Array<string | Record<string, unknown>> | null;
  cited_chunk_ids: number[];
  confidence_score?: number | null;
  last_refreshed_at: string;
}

export interface WikiPageSourceCreate {
  source_id: string;
  relevance_summary: string;
  key_points?: Array<string | Record<string, unknown>>;
  supporting_claims?: Array<string | Record<string, unknown>>;
  cited_chunk_ids?: number[];
  confidence_score?: number | null;
}

export interface WikiCompileRequest {
  title: string;
  page_type?: string;
  note_ids?: string[];
  source_ids?: string[];
  instructions?: string | null;
}

export interface WikiUpdateDraftFromSourceRequest {
  wiki_id: string;
  source_id: string;
  section?: string;
  page_type?: string;
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

export interface WikiInsightCandidate {
  id: number;
  run_id: number;
  user_id: string;
  insight_type: "pending" | "accepted" | "rejected" | "converted_to_draft" | string;
  title: string;
  summary: string;
  evidence_refs: WikiEvidenceRef[];
  metadata_?: Record<string, unknown> | null;
  status: "pending" | "accepted" | "rejected" | "converted_to_draft" | string;
  reviewer_note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WikiArticleDraft {
  id: number;
  run_id: number;
  user_id: string;
  title: string;
  page_type: string;
  summary?: string | null;
  content: string;
  evidence_refs: WikiEvidenceRef[];
  metadata_?: Record<string, unknown> | null;
  status: "candidate" | "draft" | "in_review" | "accepted" | "rejected" | "merged" | string;
  reviewer_note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WikiMiningRun {
  id: number;
  user_id: string;
  status: string;
  window_start?: string | null;
  window_end?: string | null;
  metadata_?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WikiMiningRunList {
  items: WikiMiningRun[];
  total: number;
}

export interface WikiMiningRunDetail {
  run: WikiMiningRun;
  insights: WikiInsightCandidate[];
  articles: WikiArticleDraft[];
}

export interface WikiMiningRunCreate {
  window_days?: number;
  max_new_items?: number;
  max_related_items?: number;
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
  sources: (id: string) => request<WikiPageSource[]>(`/wiki/${encodeURIComponent(id)}/sources`),
  upsertSource: (id: string, body: WikiPageSourceCreate) =>
    request<WikiPageSource>(`/wiki/${encodeURIComponent(id)}/sources`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  compile: (body: WikiCompileRequest) =>
    request<WikiPage>("/wiki/compile", { method: "POST", body: JSON.stringify(body) }),
  createUpdateDraftFromSource: (body: WikiUpdateDraftFromSourceRequest) =>
    request<WikiArticleDraft>("/wiki/update-drafts/from-source", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateDrafts: (wikiId: string) =>
    request<WikiArticleDraft[]>(`/wiki/update-drafts?wiki_id=${encodeURIComponent(wikiId)}`),
  deleteUpdateDraft: (id: number) =>
    request<void>(`/wiki/update-drafts/${id}`, { method: "DELETE" }),
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
  miningRuns: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<WikiMiningRunList>(`/wiki/mining/runs?${q}`);
  },
  miningRun: (id: number) => request<WikiMiningRunDetail>(`/wiki/mining/runs/${id}`),
  createMiningRun: (body?: WikiMiningRunCreate) =>
    request<WikiMiningRunDetail>("/wiki/mining/runs", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  updateMiningInsight: (id: number, status: "pending" | "accepted" | "rejected" | "converted_to_draft", reviewer_note?: string | null) =>
    request<WikiInsightCandidate>(`/wiki/mining/insights/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, reviewer_note }),
    }),
  deleteMiningInsight: (id: number) =>
    request<void>(`/wiki/mining/insights/${id}`, {
      method: "DELETE",
    }),
  updateMiningArticle: (
    id: number,
    body: { status: "candidate" | "draft" | "in_review" | "accepted" | "rejected" | "merged" | "applied"; reviewer_note?: string | null; wiki_title?: string | null; page_type?: string | null }
  ) =>
    request<WikiArticleDraft>(`/wiki/mining/articles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteMiningArticle: (id: number) =>
    request<void>(`/wiki/mining/articles/${id}`, {
      method: "DELETE",
    }),
  mergeMiningArticle: (id: number, body?: { target_wiki_id?: string | null; reviewer_note?: string | null }) =>
    request<WikiArticleDraft>(`/wiki/mining/articles/${id}/merge`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  convertMiningArticleToNote: (id: number) =>
    request<{ article_id: number; status: string; note_title: string; note_content: string; metadata_?: Record<string, unknown> | null }>(`/wiki/mining/articles/${id}/convert-to-note`, {
      method: "POST",
    }),
  resolveReferences: (refs: ReferenceResolveInput[]) =>
    request<{ items: ReferenceRead[] }>("/wiki/references/resolve", {
      method: "POST",
      body: JSON.stringify({ refs }),
    }),
};
