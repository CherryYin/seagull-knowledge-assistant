import { request } from "./client";

export interface AgentProfile {
  id: string;
  agent_type: string;
  name: string;
  description: string;
  system_prompt_append: string;
  model_id: string | null;
  temperature: number | null;
  enabled_tools: string[] | null;
  enabled_skills: string[] | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentProfileList {
  items: AgentProfile[];
  total: number;
}

export interface AgentProfileCreate {
  name: string;
  agent_type?: string;
  description?: string;
  system_prompt_append?: string;
  model_id?: string | null;
  temperature?: number | null;
  enabled_tools?: string[] | null;
  enabled_skills?: string[] | null;
  is_default?: boolean;
}

export interface AgentProfileUpdate {
  name?: string;
  agent_type?: string;
  description?: string;
  system_prompt_append?: string;
  model_id?: string | null;
  temperature?: number | null;
  enabled_tools?: string[] | null;
  enabled_skills?: string[] | null;
  is_default?: boolean;
}

export interface AgentTypeInfo {
  id: string;
  name: string;
  description: string;
  default_tools: string[] | null;
  default_skills: string[] | null;
}

export const agentProfilesApi = {
  list: () => request<AgentProfileList>("/agent-profiles"),
  get: (id: string) =>
    request<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`),
  create: (body: AgentProfileCreate) =>
    request<AgentProfile>("/agent-profiles", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createStoryWriterPreset: () =>
    request<AgentProfile>("/agent-profiles/presets/story-writer", {
      method: "POST",
    }),
  update: (id: string, body: AgentProfileUpdate) =>
    request<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    request<void>(`/agent-profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  setDefault: (id: string) =>
    request<AgentProfile>(
      `/agent-profiles/${encodeURIComponent(id)}/set-default`,
      { method: "POST" }
    ),
  availableTools: () => request<string[]>("/agent-profiles/available-tools"),
  allowedModels: () => request<string[]>("/agent-profiles/allowed-models"),
  types: () => request<AgentTypeInfo[]>("/agent-profiles/types"),
};
