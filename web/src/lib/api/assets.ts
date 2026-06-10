import { request } from "./client";

export type AssetStatus = "draft" | "in_review" | "ready_to_export" | "exported" | "published" | "archived";
export type AssetType = "blog_post" | "research_brief" | "knowledge_pack";

export interface Asset {
  id: string;
  user_id: string;
  asset_type: AssetType;
  status: AssetStatus;
  title: string;
  brief?: string | null;
  outline?: string | null;
  draft_content?: string | null;
  reference_notes?: string | null;
  editor_feedback?: string | null;
  source_refs: string[];
  note_refs: string[];
  memory_refs: string[];
  wiki_refs: string[];
  opinion_notes?: string | null;
  style_notes?: string | null;
  export_format?: string | null;
  exported_at?: string | null;
  published_at?: string | null;
  metadata_?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AssetList {
  items: Asset[];
  total: number;
}

export interface AssetCreate {
  title: string;
  brief?: string;
  asset_type?: AssetType;
  status?: AssetStatus;
  source_refs?: string[];
  note_refs?: string[];
  memory_refs?: string[];
  wiki_refs?: string[];
  opinion_notes?: string;
  style_notes?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetUpdate {
  title?: string;
  brief?: string;
  outline?: string;
  draft_content?: string;
  reference_notes?: string;
  editor_feedback?: string;
  status?: AssetStatus;
  source_refs?: string[];
  note_refs?: string[];
  memory_refs?: string[];
  wiki_refs?: string[];
  opinion_notes?: string;
  style_notes?: string;
  export_format?: string;
  metadata?: Record<string, unknown>;
}

export interface ReadinessCheckResult {
  ready: boolean;
  blocking_reasons: string[];
  warning_reasons: string[];
  suggestion_reasons: string[];
}

export interface AssetExportResult {
  asset_id: string;
  export_format: string;
  content: string;
}

export interface AssetPublishFeedbackUpdate {
  publish_url?: string | null;
  channel?: string | null;
  published_at?: string | null;
  feedback?: string | null;
}

export interface AssetFeedbackNoteResult {
  asset_id: string;
  note_id: string;
}

export const assetsApi = {
  list: (params?: { asset_type?: string; status?: AssetStatus; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.asset_type) q.set("asset_type", params.asset_type);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<AssetList>(`/assets?${q}`);
  },
  get: (id: string) => request<Asset>(`/assets/${encodeURIComponent(id)}`),
  create: (body: AssetCreate) => request<Asset>("/assets", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: AssetUpdate) => request<Asset>(`/assets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  generateOutline: (id: string, regenerate = false) => request<Asset>(`/assets/${encodeURIComponent(id)}/generate-outline`, { method: "POST", body: JSON.stringify({ regenerate }) }),
  generateDraft: (id: string, regenerate = false) => request<Asset>(`/assets/${encodeURIComponent(id)}/generate-draft`, { method: "POST", body: JSON.stringify({ regenerate }) }),
  attachReferences: (id: string, include_reference_notes = true) => request<Asset>(`/assets/${encodeURIComponent(id)}/attach-references`, { method: "POST", body: JSON.stringify({ include_reference_notes }) }),
  checkReadiness: (id: string) => request<ReadinessCheckResult>(`/assets/${encodeURIComponent(id)}/check-readiness`, { method: "POST" }),
  exportMarkdown: (id: string) => request<AssetExportResult>(`/assets/${encodeURIComponent(id)}/export/markdown`, { method: "POST" }),
  updatePublishFeedback: (id: string, body: AssetPublishFeedbackUpdate) => request<Asset>(`/assets/${encodeURIComponent(id)}/publish-feedback`, { method: "POST", body: JSON.stringify(body) }),
  feedbackToNote: (id: string) => request<AssetFeedbackNoteResult>(`/assets/${encodeURIComponent(id)}/feedback-to-note`, { method: "POST" }),
};
