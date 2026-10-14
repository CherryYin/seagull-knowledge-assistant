import { request } from "./client";
import type { CalendarReminder, CalendarReminderCreate, CalendarReminderUpdate } from "./calendar-reminders";

export type ProjectStatus = "active" | "completed";
export type ProjectResourceType = "source" | "note" | "wiki" | "asset" | "chat_session";

export interface Project {
  id: string;
  title: string;
  goal: string;
  completion_criteria: string;
  status: ProjectStatus;
  revision: number;
  next_reminder_id?: string | null;
  archived_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  resource_counts: Record<string, number>;
}

export interface ProjectList { items: Project[]; total: number }
export interface ProjectTaskList {
  items: CalendarReminder[]; total: number; pending_count: number; completed_count: number;
  next_task: CalendarReminder | null;
}
export interface ProjectInput { title: string; goal: string; completion_criteria: string }
export interface ProjectResourceRef { resource_type: ProjectResourceType; resource_id: string; reason?: string }
export interface ProjectResourceOption extends ProjectResourceRef {
  title: string;
  status: string | null;
  href: string;
  updated_at: string | null;
}
export interface ProjectResource extends ProjectResourceOption { id: string; reason: string; created_at: string }
export interface ProjectResourceList { items: ProjectResource[]; total: number; revision: number }

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
  return query.toString();
}

export const projectsApi = {
  tasks: (id: string, params: { kind?: "once" | "recurring"; start?: string; end?: string; include_done?: boolean; limit?: number; offset?: number } = {}) =>
    request<ProjectTaskList>(`/projects/${encodeURIComponent(id)}/tasks?${queryString(params)}`),
  createTask: (id: string, body: CalendarReminderCreate) =>
    request<CalendarReminder>(`/projects/${encodeURIComponent(id)}/tasks`, { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, taskId: string, body: CalendarReminderUpdate) =>
    request<CalendarReminder>(`/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify(body) }),
  attachTask: (id: string, taskId: string, base_revision: number) =>
    request<CalendarReminder>(`/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/attach`, { method: "POST", body: JSON.stringify({ base_revision }) }),
  detachTask: (id: string, taskId: string, base_revision: number) =>
    request<CalendarReminder>(`/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}?${queryString({ base_revision })}`, { method: "DELETE" }),
  nextTask: (id: string, reminder_id: string | null, base_revision: number) =>
    request<Project>(`/projects/${encodeURIComponent(id)}/next-task`, { method: "PATCH", body: JSON.stringify({ reminder_id, base_revision }) }),
  list: (params: { status?: ProjectStatus; archived?: boolean; query?: string; limit?: number; offset?: number } = {}) =>
    request<ProjectList>(`/projects?${queryString(params)}`),
  create: (body: ProjectInput) => request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  get: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),
  update: (id: string, body: Partial<ProjectInput> & { base_revision: number; status?: ProjectStatus }) =>
    request<Project>(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  archive: (id: string, base_revision: number, restore = false) =>
    request<Project>(`/projects/${encodeURIComponent(id)}/${restore ? "restore" : "archive"}`, { method: "POST", body: JSON.stringify({ base_revision }) }),
  resources: (id: string, params: { resource_type?: ProjectResourceType; limit?: number; offset?: number } = {}) =>
    request<ProjectResourceList>(`/projects/${encodeURIComponent(id)}/resources?${queryString(params)}`),
  addResources: (id: string, base_revision: number, resources: ProjectResourceRef[]) =>
    request<{ project: Project; added: number }>(`/projects/${encodeURIComponent(id)}/resources`, {
      method: "POST", body: JSON.stringify({ base_revision, resources }),
    }),
  removeResource: (id: string, linkId: string, base_revision: number) =>
    request<Project>(`/projects/${encodeURIComponent(id)}/resources/${encodeURIComponent(linkId)}?${queryString({ base_revision })}`, { method: "DELETE" }),
  options: (params: { resource_type: ProjectResourceType; query?: string; limit?: number; offset?: number }) =>
    request<{ items: ProjectResourceOption[]; total: number }>(`/projects/resource-options?${queryString(params)}`),
  forResource: (params: { resource_type: ProjectResourceType; resource_id: string; limit?: number; offset?: number }) =>
    request<ProjectList>(`/projects/for-resource?${queryString(params)}`),
};
