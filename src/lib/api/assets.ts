import { request } from "./client";

export type AssetStatus = "draft" | "in_review" | "ready_to_export" | "exported" | "published" | "archived";
export type AssetType = "blog_post" | "research_brief" | "knowledge_pack" | "newsletter_issue" | "topic_report";

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

export interface AssetKnowledgeLineageItem {
  asset_id: string;
  asset_title: string;
  asset_type: AssetType;
  asset_status: AssetStatus;
  relation: "distilled" | "referenced";
  candidate_id?: string | null;
  candidate_type?: "note" | "wiki" | null;
  candidate_action?: "create" | "update" | null;
  claim_refs: string[];
  contribution_summary?: string | null;
  promoted_at?: string | null;
}

export interface AssetKnowledgeLineageList {
  target_type: "note" | "wiki";
  target_id: string;
  items: AssetKnowledgeLineageItem[];
}

export interface AssetCreate {
  title: string;
  brief?: string;
  outline?: string;
  draft_content?: string;
  asset_type?: AssetType;
  status?: AssetStatus;
  source_refs?: string[];
  note_refs?: string[];
  wiki_refs?: string[];
  opinion_notes?: string;
  style_notes?: string;
  metadata?: Record<string, unknown>;
  provenance?: {
    origin_type: "harness_session" | "user";
    origin_ref?: string;
    action?: "save" | "keep" | "publish";
  };
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

export interface AssetQualityFinding {
  id: string;
  severity: "P0" | "P1" | "P2";
  title: string;
  detail: string;
}

export interface AssetQualityAuditResult {
  asset_id: string;
  workspace_revision: number;
  verdict: "pass" | "warn" | "block";
  score: number;
  blocking_findings: AssetQualityFinding[];
  warnings: AssetQualityFinding[];
  metrics: Record<string, number>;
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

export interface NewsletterAutomationConfig {
  config_revision: number;
  enabled: boolean;
  name: string;
  topics: string[];
  frequency: "manual" | "daily" | "weekly";
  hour_utc: number;
  weekday_utc: number;
  lookback_days: number;
  max_news_items: number;
  max_paper_items: number;
  delivery_format: "markdown" | "html";
  audience: string;
  style_notes: string;
  last_generated_at?: string | null;
  last_asset_id?: string | null;
  last_run_at?: string | null;
  last_run_status?: "generated" | "skipped" | null;
  last_run_reason?: string | null;
  last_news_count: number;
  last_paper_count: number;
}

export type NewsletterAutomationUpdate = Omit<NewsletterAutomationConfig, "config_revision" | "last_generated_at" | "last_asset_id" | "last_run_at" | "last_run_status" | "last_run_reason" | "last_news_count" | "last_paper_count">;

export interface NewsletterAutomationRunSnapshot extends NewsletterAutomationUpdate {
  config_revision: number;
}

export interface NewsletterAutomationRunResult {
  status: "generated" | "skipped";
  reason?: string | null;
  news_count: number;
  paper_count: number;
  config_revision: number;
  config_snapshot?: NewsletterAutomationRunSnapshot | null;
  asset?: Asset | null;
}

export interface AssetIntent {
  revision: number;
  question: string;
  goal: string;
  audience?: string | null;
  creation_mode: string;
  scope: string[];
  constraints: string[];
  status: "confirmed";
  confirmed_by: string;
  confirmed_at: string;
}

export type AssetEvidenceRelation = "supports" | "contradicts" | "context" | "unverified";
export type AssetEvidenceStatus = "proposed" | "accepted" | "rejected" | "stale";

export interface AssetEvidence {
  id: string;
  target_type: "source" | "note" | "wiki" | "web";
  target_id: string;
  relation: AssetEvidenceRelation;
  summary: string;
  fragment_selector?: Record<string, unknown> | null;
  status: AssetEvidenceStatus;
  authorship: "agent";
  intent_revision: number;
  source_session_id?: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
}

export interface AssetWorkspace {
  asset_id: string;
  workspace_revision: number;
  intent?: AssetIntent | null;
  intent_history: AssetIntent[];
  evidence: AssetEvidence[];
  claims: AssetClaim[];
  contribution?: AssetContribution | null;
  knowledge_candidates: AssetKnowledgeCandidate[];
  decision_items: Record<string, unknown>[];
}

export interface AssetIntentRevisionRequest {
  base_workspace_revision: number;
  question: string;
  goal: string;
  audience?: string | null;
  creation_mode: string;
  scope: string[];
  constraints: string[];
}

export interface AssetEvidenceProposalInput {
  target_type: AssetEvidence["target_type"];
  target_id: string;
  relation: AssetEvidenceRelation;
  summary: string;
  fragment_selector?: Record<string, unknown> | null;
}

export type AssetClaimKind = "inference" | "hypothesis" | "recommendation" | "synthesis";
export type AssetClaimStatus = "proposed" | "accepted" | "rejected" | "hypothesis" | "needs_more_evidence" | "superseded";

export interface AssetClaim {
  id: string;
  content: string;
  kind: AssetClaimKind;
  status: AssetClaimStatus;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  agent_confidence: "low" | "medium" | "high";
  authorship: "agent";
  intent_revision: number;
  source_session_id?: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  user_edited: boolean;
}

export interface AssetClaimProposalInput {
  content: string;
  kind: AssetClaimKind;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  agent_confidence: AssetClaim["agent_confidence"];
}

export type AssetContributionKind = "user_viewpoint" | "synthesis" | "decision" | "framework" | "hypothesis" | "wiki_correction";

export interface AssetContribution {
  id: string;
  kind: AssetContributionKind;
  summary: string;
  claim_refs: string[];
  status: "proposed" | "accepted" | "rejected";
  authorship: "agent";
  attribution?: "agent_synthesis" | "user_insight" | null;
  source_session_id?: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  user_edited: boolean;
}

export interface AssetKnowledgeCandidate {
  id: string;
  candidate_type: "note" | "wiki";
  action: "create" | "update";
  target_wiki_id?: string | null;
  title: string;
  content: string;
  claim_refs: string[];
  status: "proposed" | "kept" | "rejected" | "promoted";
  authorship: "agent";
  source_session_id?: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  promoted_at?: string | null;
  promoted_by?: string | null;
  promoted_target_type?: "note" | "wiki" | null;
  promoted_target_id?: string | null;
  user_edited: boolean;
}

export interface AssetKnowledgeProposalInput {
  contribution: {
    kind: AssetContributionKind;
    summary: string;
    claim_refs: string[];
  };
  candidates: Array<{
    candidate_type: AssetKnowledgeCandidate["candidate_type"];
    action: AssetKnowledgeCandidate["action"];
    target_wiki_id?: string | null;
    title: string;
    content: string;
    claim_refs: string[];
  }>;
}

export const reviseAssetIntent = (id: string, body: AssetIntentRevisionRequest) => request<AssetWorkspace>(
  `/assets/${encodeURIComponent(id)}/workspace/intent`,
  { method: "POST", body: JSON.stringify(body) },
);

export const assetsApi = {
  list: (params?: { asset_type?: string; status?: AssetStatus; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.asset_type) q.set("asset_type", params.asset_type);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<AssetList>(`/assets?${q}`);
  },
  knowledgeLineage: (targetType: "note" | "wiki", targetId: string) => request<AssetKnowledgeLineageList>(
    `/assets/knowledge-lineage?target_type=${encodeURIComponent(targetType)}&target_id=${encodeURIComponent(targetId)}`,
  ),
  get: (id: string) => request<Asset>(`/assets/${encodeURIComponent(id)}`),
  getWorkspace: (id: string) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace`),
  getQualityAudit: (id: string) => request<AssetQualityAuditResult>(`/assets/${encodeURIComponent(id)}/quality-audit`),
  create: (body: AssetCreate) => request<Asset>("/assets", { method: "POST", body: JSON.stringify(body) }),
  getNewsletterAutomation: () => request<NewsletterAutomationConfig>("/assets/newsletter/automation"),
  updateNewsletterAutomation: (body: NewsletterAutomationUpdate) => request<NewsletterAutomationConfig>("/assets/newsletter/automation", { method: "PUT", body: JSON.stringify(body) }),
  runNewsletterAutomation: () => request<NewsletterAutomationRunResult>("/assets/newsletter/automation/run", { method: "POST" }),
  reviseIntent: reviseAssetIntent,
  proposeEvidence: (id: string, body: { base_workspace_revision: number; session_id?: string; proposals: AssetEvidenceProposalInput[] }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/evidence/proposals`, { method: "POST", body: JSON.stringify(body) }),
  decideEvidence: (id: string, evidenceId: string, body: { base_workspace_revision: number; decision: "accepted" | "rejected" }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/evidence/${encodeURIComponent(evidenceId)}/decision`, { method: "POST", body: JSON.stringify(body) }),
  proposeClaims: (id: string, body: { base_workspace_revision: number; session_id?: string; proposals: AssetClaimProposalInput[] }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/claims/proposals`, { method: "POST", body: JSON.stringify(body) }),
  decideClaim: (id: string, claimId: string, body: { base_workspace_revision: number; decision: "accept" | "edit_and_accept" | "reject" | "keep_as_hypothesis" | "need_more_evidence"; edited_content?: string }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/claims/${encodeURIComponent(claimId)}/decision`, { method: "POST", body: JSON.stringify(body) }),
  proposeKnowledge: (id: string, body: { base_workspace_revision: number; session_id?: string } & AssetKnowledgeProposalInput) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/knowledge/proposals`, { method: "POST", body: JSON.stringify(body) }),
  decideContribution: (id: string, body: { base_workspace_revision: number; decision: "accept" | "edit_and_accept" | "reject"; attribution?: "agent_synthesis" | "user_insight"; edited_summary?: string }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/contribution/decision`, { method: "POST", body: JSON.stringify(body) }),
  decideKnowledgeCandidate: (id: string, candidateId: string, body: { base_workspace_revision: number; decision: "keep" | "reject" }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/knowledge/${encodeURIComponent(candidateId)}/decision`, { method: "POST", body: JSON.stringify(body) }),
  promoteKnowledgeCandidate: (id: string, candidateId: string, body: { base_workspace_revision: number; confirm: true; confirm_overwrite?: boolean; edited_title?: string; edited_content?: string }) => request<AssetWorkspace>(`/assets/${encodeURIComponent(id)}/workspace/knowledge/${encodeURIComponent(candidateId)}/promote`, { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: AssetUpdate) => request<Asset>(`/assets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (id: string) => request<void>(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  attachReferences: (id: string, include_reference_notes = true) => request<Asset>(`/assets/${encodeURIComponent(id)}/attach-references`, { method: "POST", body: JSON.stringify({ include_reference_notes }) }),
  checkReadiness: (id: string) => request<ReadinessCheckResult>(`/assets/${encodeURIComponent(id)}/check-readiness`, { method: "POST" }),
  exportMarkdown: (id: string) => request<AssetExportResult>(`/assets/${encodeURIComponent(id)}/export/markdown`, { method: "POST" }),
  previewHtml: (id: string) => request<AssetExportResult>(`/assets/${encodeURIComponent(id)}/preview/html`),
  exportHtml: (id: string) => request<AssetExportResult>(`/assets/${encodeURIComponent(id)}/export/html`, { method: "POST" }),
  updatePublishFeedback: (id: string, body: AssetPublishFeedbackUpdate) => request<Asset>(`/assets/${encodeURIComponent(id)}/publish-feedback`, { method: "POST", body: JSON.stringify(body) }),
  feedbackToNote: (id: string) => request<AssetFeedbackNoteResult>(`/assets/${encodeURIComponent(id)}/feedback-to-note`, { method: "POST" }),
};
