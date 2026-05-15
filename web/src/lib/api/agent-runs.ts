import { request } from "./client";

export type AgentRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "thinking"
  | "searching"
  | "reading"
  | "writing"
  | "tool_calling"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunStatusItem {
  profile_id: string;
  profile_name: string;
  agent_type: string;
  status: AgentRunStatus;
  current_task: string | null;
  last_active_at: string | null;
  last_result_preview: string | null;
  run_id: string | null;
}

export interface AgentRun {
  id: string;
  user_id: string;
  profile_id: string | null;
  agent_type: string;
  status: AgentRunStatus;
  task: string;
  summary: string | null;
  result_preview: string | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunEvent {
  id: string;
  run_id: string;
  user_id: string;
  event_type: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AgentRunList {
  items: AgentRun[];
  total: number;
}

export interface AgentRunFilters {
  profile_id?: string;
  agent_type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

function toQuery(filters: AgentRunFilters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const agentRunsApi = {
  status: () => request<AgentRunStatusItem[]>("/agent-runs/status"),
  list: (filters?: AgentRunFilters) => request<AgentRunList>(`/agent-runs${toQuery(filters)}`),
  get: (id: string) => request<AgentRun>(`/agent-runs/${encodeURIComponent(id)}`),
  events: (id: string) =>
    request<AgentRunEvent[]>(`/agent-runs/${encodeURIComponent(id)}/events`),
};
