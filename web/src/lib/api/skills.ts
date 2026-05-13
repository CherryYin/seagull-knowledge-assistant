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

export const skillsApi = {
  list: () => request<Skill[]>("/skills"),
  get: (name: string) => request<Skill>(`/skills/${encodeURIComponent(name)}`),
  delete: (name: string) =>
    request<void>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
