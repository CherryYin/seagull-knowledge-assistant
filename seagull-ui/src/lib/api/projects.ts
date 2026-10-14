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
export type TodoResourceRole = "context" | "result";
export interface TodoResource extends ProjectResource {
  role: TodoResourceRole; reminder_id: string; task_text: string; task_done: boolean;
}
export interface TodoResourceList { items: TodoResource[]; total: number; revision: number | null }
export interface ProjectContextRequest {
  base_revision: number; reminder_id?: string | null;
  resources: Array<{ resource_type: "source" | "note" | "wiki" | "asset"; resource_id: string }>;
  expected_fingerprint?: string;
}
export interface ProjectContextSnapshot {
  version: 1; project_id: string; project_revision: number; title: string; goal: string;
  completion_criteria: string; status: ProjectStatus; generated_at: string;
  task: { id: string; text: string; is_done: boolean; date: string | null; recurrence: string; updated_at: string | null } | null;
  resources: Array<ProjectResourceOption & { summary: string; truncated: boolean }>;
  context_text: string; truncated: boolean; fingerprint: string; launch_fingerprint?: string | null;
}

export function contextRequest(snapshot: ProjectContextSnapshot): ProjectContextRequest {
  return { base_revision: snapshot.project_revision, reminder_id: snapshot.task?.id ?? null,
    resources: snapshot.resources.map(item => ({ resource_type: item.resource_type as "source" | "note" | "wiki" | "asset", resource_id: item.resource_id })), expected_fingerprint: snapshot.fingerprint };
}

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
  return query.toString();
}

export const projectsApi = {
  linkSavedResult: (id: string, body: { base_revision: number; resource_type: "note" | "asset" | "wiki"; resource_id: string; reminder_id: string | null }) =>
    request<{ project: Project; resource_type: "note" | "asset" | "wiki"; resource_id: string; reminder_id: string | null }>(`/projects/${encodeURIComponent(id)}/saved-result`, { method: "POST", body: JSON.stringify(body) }),
  previewContext: (id: string, body: ProjectContextRequest) =>
    request<ProjectContextSnapshot>(`/projects/${encodeURIComponent(id)}/context-preview`, { method: "POST", body: JSON.stringify(body) }),
  createContextSession: (id: string, body: ProjectContextRequest & { session_id: string; expected_fingerprint: string }) =>
    request<import("./chat-sessions").ChatSessionRecord>(`/projects/${encodeURIComponent(id)}/context-session`, { method: "POST", body: JSON.stringify(body) }),
  updateContextSession: (id: string, sessionId: string, body: ProjectContextRequest) =>
    request<import("./chat-sessions").ChatSessionRecord>(`/projects/${encodeURIComponent(id)}/context-session/${encodeURIComponent(sessionId)}`, { method: "PUT", body: JSON.stringify(body) }),
  taskResources: (id: string, taskId: string, params: { role?: TodoResourceRole; limit?: number; offset?: number } = {}) =>
    request<TodoResourceList>(`/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/resources?${queryString(params)}`),
  todoResources: (taskId: string, params: { limit?: number; offset?: number } = {}) =>
    request<TodoResourceList>(`/calendar/reminders/${encodeURIComponent(taskId)}/resources?${queryString(params)}`),
  addTaskResources: (id: string, taskId: string, base_revision: number, role: TodoResourceRole, resources: ProjectResourceRef[]) =>
    request<TodoResourceList>(`/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/resources`, {
      method: "POST", body: JSON.stringify({ base_revision, role, resources }),
    }),
  removeTaskResource: (id: string, taskId: string, linkId: string, base_revision: number) =>
    request<TodoResourceList>(`/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/resources/${encodeURIComponent(linkId)}?${queryString({ base_revision })}`, { method: "DELETE" }),
  taskResults: (id: string, params: { limit?: number; offset?: number } = {}) =>
    request<TodoResourceList>(`/projects/${encodeURIComponent(id)}/task-results?${queryString(params)}`),
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
