import { request } from "./client";

export type ExperimentStatus = "prepared" | "train_running" | "awaiting_review" | "holdout_running" | "completed" | "stopped" | "outcome_unknown" | "interrupted";
export type ExperimentWinner = "baseline" | "candidate" | "tie" | "neither";
export interface ExperimentSummary {
  id: string;
  name: string;
  status: ExperimentStatus;
  created_at: string;
}
export interface ExperimentOutput {
  status: string;
  estimated_cny: string | null;
  response: {
    text: string;
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    elapsed_ms: number | null;
    retry_count: number | null;
  } | null;
}
export interface ExperimentCase {
  id: string;
  split: "train" | "holdout";
  material: string | null;
  outputs: Record<"baseline" | "candidate", ExperimentOutput>;
  review: { winner: ExperimentWinner; reason: string; reviewed_at: string } | null;
}
export interface Harness2Experiment extends ExperimentSummary {
  message: string | null;
  phase: "train" | "holdout" | null;
  method: "manual_prompt_ab_not_full_harness2";
  synthetic: true;
  prompts: Record<"baseline" | "candidate", string>;
  cases: ExperimentCase[];
  attempts: number;
  spent_estimate_cny: string | null;
  spent_or_reserved_cny: string;
  outcome_unknown: boolean;
  budget_cny: string | null;
}
export interface ExperimentPreflight {
  ready: boolean;
  blockers: string[];
  preflight_id: string | null;
  network_requests_sent: number;
  phase: "train" | "holdout";
  budget_cny: string;
  model?: string;
  requests?: number;
  phase_reservation_cny?: string;
  spent_or_reserved_cny?: string;
  pricing_expires_at?: string;
}

const base = "/lab/harness2";
const post = <Result>(path: string, body: unknown = {}) => request<Result>(path, { method: "POST", body: JSON.stringify(body) });
export const harness2Api = {
  list: () => request<{ items: ExperimentSummary[] }>(base),
  create: () => post<Harness2Experiment>(base),
  get: (id: string) => request<Harness2Experiment>(`${base}/${id}`),
  preflight: (id: string, phase: "train" | "holdout", budget: string) => post<ExperimentPreflight>(`${base}/${id}/preflight`, { phase, budget_cny: budget }),
  start: (id: string, preflightId: string) => post<{ id: string; status: ExperimentStatus }>(`${base}/${id}/start`, { preflight_id: preflightId, confirm_send_synthetic: true }),
  review: (id: string, caseId: string, winner: ExperimentWinner, reason: string) => post<Harness2Experiment>(`${base}/${id}/review`, { case_id: caseId, winner, reason }),
  saveNote: (id: string) => post<{ note_id: string }>(`${base}/${id}/note`),
};
