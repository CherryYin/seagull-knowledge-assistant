import { request, requestBlob } from "./client";

export type PublicationMetricName = "read" | "like" | "look" | "share" | "comment" | "collect";
export type BrowserMetricField = "read_num" | "read_uv" | "like_num" | "old_like_num" | "share_num" | "share_uv" | "comment_num" | "collect_num" | "favorite_num";
export interface PublicationStatisticsSnapshot {
  id: string;
  source: "manual_backend" | "browser_report";
  account_label: string;
  period_kind: "cumulative" | "range";
  period_start: string;
  period_end: string;
  captured_at: string;
  metrics: Partial<Record<PublicationMetricName, { value: number; unit: "people" | "times"; source_field: BrowserMetricField | null }>>;
  notes: string;
  user_confirmed: true;
}

export interface PodcastDeliveryFields {
  base_revision: number;
  render_id: string;
  channel: string;
  publish_url: string | null;
  published_at: string | null;
  confirm_published: boolean;
  notes: string;
  adoption: "undecided" | "original" | "modified" | "not_used";
  manual_steps: Array<"script" | "pronunciation" | "speed" | "editing" | "upload" | "other">;
  feedback: string;
  statistics_snapshots?: PublicationStatisticsSnapshot[];
}

export interface PodcastDeliveryRecord extends PodcastDeliveryFields {
  id: string;
  revision: number;
  script_approval_id: string;
  file_sha256: string;
  created_at: string;
  updated_at: string;
  recorded_by: string;
}

export interface PodcastConfiguration {
  provider: "qwen";
  region: "cn-beijing";
  model: "qwen3-tts-flash";
  voice_id: string;
  target_duration_minutes: number;
  information_cutoff_at: string | null;
}

export interface PodcastState {
  asset_id: string;
  configuration: PodcastConfiguration & {
    asset_id: string;
    revision: number;
    created_at: string;
    updated_at: string;
  };
  script_approval_available: true;
  audio_generation_available: boolean;
}

export interface PodcastVoiceCatalog {
  provider: "qwen";
  region: "cn-beijing";
  model: "qwen3-tts-flash";
  source: string;
  checked_on: string;
  items: Array<{
    id: string;
    name: string;
    gender: "男声" | "女声";
    languages: string[];
  }>;
}

export interface PodcastDraftFields {
  title: string;
  brief: string;
  outline: string;
  draft_content: string;
  source_refs: string[];
  note_refs: string[];
  wiki_refs: string[];
  configuration: PodcastConfiguration;
  paragraph_sources?: PodcastParagraphSource[];
}

export interface PodcastParagraphSource {
  paragraph_index: number;
  text_hash: string;
  material_refs: Array<{ kind: "source" | "note" | "wiki"; id: string }>;
}

export interface PodcastApproval {
  id: string;
  asset_id: string;
  config_revision: number;
  script_hash: string;
  input_hash: string;
  spoken_text: string;
  source_snapshot: PodcastMaterial[];
  config_snapshot: Record<string, unknown>;
  approved_by: string;
  created_at: string;
}

export interface PodcastMaterial {
  kind: "source" | "note" | "wiki";
  id: string;
  available: boolean;
  title?: string;
  excerpt?: string;
  content_hash?: string;
  paragraph_indexes?: number[];
}

export interface PodcastDraft extends Omit<PodcastDraftFields, "configuration"> {
  asset_id: string;
  status: string;
  configuration: PodcastState["configuration"];
  input_hash: string;
  spoken_text: string;
  materials: PodcastMaterial[];
  approval_status: "unconfirmed" | "current" | "stale";
  latest_approval: PodcastApproval | null;
  approval_issues: string[];
  audio_generation_available: boolean;
}

export interface PodcastAudioPreflightRequest {
  base_input_hash: string;
  budget_limit: string;
  credential_id: number | null;
  price_per_10k_characters: string | null;
}

export interface PodcastAudioPreflight {
  asset_id: string;
  input_hash: string;
  script_approval_id: string;
  script_hash: string;
  configuration: PodcastConfiguration;
  credential_id: number | null;
  credential_label: string | null;
  credential_checks_passed: boolean;
  budget_limit: string;
  currency: "CNY";
  price_per_10k_characters: string | null;
  pricing_source: "user_entered" | null;
  pricing_verified: false;
  character_count: number;
  reserved_character_count: number;
  segmentation_version: "utf16-300-double-reserve-v3";
  segments: Array<{
    position: number;
    spoken_text: string;
    text_hash: string;
    character_count: number;
    reserved_character_count: number;
    estimated_cost: string | null;
  }>;
  estimated_cost: string | null;
  budget_sufficient: boolean | null;
  active_render_id: string | null;
  active_render_status: string | null;
  checks_passed: boolean;
  issues: Array<{ code: string; message: string }>;
  warnings: string[];
  checked_at: string;
  audio_generation_available: boolean;
  execution_fingerprint: string;
  pricing_policy_id: string;
  pricing_policy_current: boolean;
}

export interface PodcastAudioRenderRequest extends PodcastAudioPreflightRequest {
  idempotency_key: string;
  execution_fingerprint: string;
  authorize_text_to_provider: true;
  acknowledge_billing_uncertainty: true;
}

export interface PodcastAudioFailure {
  stage: string;
  code: string;
  elapsed_ms: number;
  http_status: number | null;
  provider_request_id: string | null;
  exception_type?: string | null;
  provider_error_code?: string | null;
  retry_after_seconds?: number | null;
}

export interface PodcastAudioAttempt {
  id: string;
  segment_position: number;
  status: string;
  error_code: string | null;
  provider_request_id: string | null;
  billable_characters: number | null;
  started_at: string;
  completed_at: string | null;
  failure_details: PodcastAudioFailure | null;
}

export interface PodcastAudioRender {
  id: string;
  asset_id: string;
  script_approval_id: string;
  input_hash: string;
  status: "queued" | "generating" | "assembling" | "ready" | "failed" | "canceled" | "outcome_unknown" | "abandoned";
  budget_limit: string;
  currency: "CNY";
  estimated_cost: string | null;
  duration_seconds: string | null;
  file_sha256: string | null;
  segment_count: number;
  ready_segment_count: number;
  attempt_count: number;
  reported_characters: number | null;
  reported_cost: string | null;
  error_message: string | null;
  failure_details?: PodcastAudioFailure | null;
  attempts?: PodcastAudioAttempt[];
  can_abandon?: boolean;
  abandonment?: {
    abandoned_by: string;
    abandoned_at: string;
    previous_status: "outcome_unknown" | "failed" | "canceled";
    acknowledge_billing_uncertainty: true;
    acknowledge_full_regeneration: true;
  } | null;
  created_at: string;
  completed_at: string | null;
}

export const podcastsApi = {
  deliveryRecords: (assetId: string) => request<{ items: PodcastDeliveryRecord[] }>(`/assets/${encodeURIComponent(assetId)}/podcast/delivery-records`),
  saveDeliveryRecord: (assetId: string, recordId: string, body: PodcastDeliveryFields) => request<PodcastDeliveryRecord>(
    `/assets/${encodeURIComponent(assetId)}/podcast/delivery-records/${encodeURIComponent(recordId)}`,
    { method: "PUT", body: JSON.stringify(body) },
  ),
  audioFile: (assetId: string, renderId: string, signal?: AbortSignal) => requestBlob(
    `/assets/${encodeURIComponent(assetId)}/podcast/audio-renders/${encodeURIComponent(renderId)}/download`, { signal },
  ),
  audioRenders: (assetId: string) => request<{ items: PodcastAudioRender[] }>(`/assets/${encodeURIComponent(assetId)}/podcast/audio-renders`),
  createAudioRender: (assetId: string, body: PodcastAudioRenderRequest) => request<PodcastAudioRender>(
    `/assets/${encodeURIComponent(assetId)}/podcast/audio-renders`, { method: "POST", body: JSON.stringify(body) },
  ),
  cancelAudioRender: (assetId: string, renderId: string) => request<PodcastAudioRender>(
    `/assets/${encodeURIComponent(assetId)}/podcast/audio-renders/${encodeURIComponent(renderId)}/cancel`, { method: "POST" },
  ),
  abandonAudioRender: (assetId: string, renderId: string, body: { acknowledge_billing_uncertainty: true; acknowledge_full_regeneration: true }) => request<PodcastAudioRender>(
    `/assets/${encodeURIComponent(assetId)}/podcast/audio-renders/${encodeURIComponent(renderId)}/abandon`, { method: "POST", body: JSON.stringify(body) },
  ),
  preflightAudio: (assetId: string, body: PodcastAudioPreflightRequest) => request<PodcastAudioPreflight>(
    `/assets/${encodeURIComponent(assetId)}/podcast/audio-preflight`, { method: "POST", body: JSON.stringify(body) },
  ),
  create: (body: PodcastDraftFields) => request<PodcastDraft>("/assets/podcast", { method: "POST", body: JSON.stringify(body) }),
  draft: (assetId: string) => request<PodcastDraft>(`/assets/${encodeURIComponent(assetId)}/podcast/draft`),
  saveDraft: (assetId: string, body: PodcastDraftFields & { base_input_hash: string }) => request<PodcastDraft>(
    `/assets/${encodeURIComponent(assetId)}/podcast/draft`, { method: "PUT", body: JSON.stringify(body) },
  ),
  approve: (assetId: string, baseInputHash: string) => request<PodcastDraft>(
    `/assets/${encodeURIComponent(assetId)}/podcast/script-approvals`,
    { method: "POST", body: JSON.stringify({ base_input_hash: baseInputHash }) },
  ),
  voices: () => request<PodcastVoiceCatalog>("/assets/podcast/voices"),
  get: (assetId: string) => request<PodcastState>(`/assets/${encodeURIComponent(assetId)}/podcast`),
  update: (assetId: string, body: PodcastConfiguration & { base_revision: number }) => request<PodcastState>(
    `/assets/${encodeURIComponent(assetId)}/podcast`,
    { method: "PUT", body: JSON.stringify(body) },
  ),
};
