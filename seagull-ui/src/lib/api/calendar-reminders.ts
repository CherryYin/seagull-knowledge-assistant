import { request } from "./client";

export interface CalendarReminder {
  id: string;
  user_id: string;
  date: string | null;
  project_id?: string | null;
  project_revision?: number | null;
  completed_at?: string | null;
  text: string;
  note_id?: string | null;
  note_ids: string[];
  linked_note?: {
    id: string;
    title: string;
    status: string;
  } | null;
  linked_notes: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  recurrence: "once" | "daily" | "weekly" | "biweekly";
  is_done: boolean;
  created_at: string;
  updated_at: string;
}

export interface CalendarReminderList {
  items: CalendarReminder[];
  total: number;
  overdue_count: number;
}

export interface CalendarReminderCreate {
  date?: string | null;
  project_id?: string | null;
  base_revision?: number;
  text: string;
  note_id?: string | null;
  note_ids?: string[];
  recurrence?: "once" | "daily" | "weekly" | "biweekly";
}

export interface CalendarReminderUpdate {
  date?: string | null;
  project_id?: string | null;
  base_revision?: number;
  target_revision?: number;
  text?: string;
  note_id?: string | null;
  note_ids?: string[];
  recurrence?: "once" | "daily" | "weekly" | "biweekly";
  is_done?: boolean;
  occurrence_date?: string;
}

export const calendarRemindersApi = {
  list: (params?: { start?: string; end?: string; include_done?: boolean; note_id?: string;
    include_unscheduled?: boolean; unscheduled_only?: boolean; completed_only?: boolean; unassigned_only?: boolean;
    completion_start?: string; completion_end?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.start) q.set("start", params.start);
    if (params?.end) q.set("end", params.end);
    if (params?.include_done !== undefined) q.set("include_done", String(params.include_done));
    if (params?.note_id) q.set("note_id", params.note_id);
    for (const key of ["include_unscheduled", "unscheduled_only", "completed_only", "unassigned_only", "completion_start", "completion_end", "limit", "offset"] as const) {
      if (params?.[key] !== undefined) q.set(key, String(params[key]));
    }
    return request<CalendarReminderList>(`/calendar/reminders?${q}`);
  },
  create: (body: CalendarReminderCreate) =>
    request<CalendarReminder>("/calendar/reminders", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: CalendarReminderUpdate) =>
    request<CalendarReminder>(`/calendar/reminders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (id: string, baseRevision?: number) =>
    request<void>(`/calendar/reminders/${encodeURIComponent(id)}${baseRevision ? `?base_revision=${baseRevision}` : ""}`, { method: "DELETE" }),
};
