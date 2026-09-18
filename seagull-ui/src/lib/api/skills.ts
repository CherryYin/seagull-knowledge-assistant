import { request } from "./client";

export interface SkillArg {
  name: string;
  description: string;
  required: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  args: SkillArg[];
  template: string;
  tools_file: string | null;
  file_path: string | null;
  source: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SkillCreateRequest {
  name: string;
  description: string;
  args: SkillArg[];
  template: string;
  tools_file?: string | null;
}

export interface SkillFindResponse {
  result: string;
  candidates: SkillCreateRequest[];
}

export const skillsApi = {
  list: () => request<Skill[]>("/skills"),
  get: (name: string) => request<Skill>(`/skills/${encodeURIComponent(name)}`),
  find: (topic: string, max_results = 6) =>
    request<SkillFindResponse>("/skills/find", {
      method: "POST",
      body: JSON.stringify({ topic, max_results }),
    }),
  create: (body: SkillCreateRequest) =>
    request<Skill>("/skills", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  delete: (name: string) =>
    request<void>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
