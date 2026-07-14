import { request } from "./client";

export interface CalendarReminder {
  id: string;
  user_id: string;
  date: string;
  text: string;
  note_id?: string | null;
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
  date: string;
  text: string;
  note_id?: string | null;
  recurrence?: "once" | "daily" | "weekly" | "biweekly";
}

export interface CalendarReminderUpdate {
  text?: string;
  note_id?: string | null;
  recurrence?: "once" | "daily" | "weekly" | "biweekly";
  is_done?: boolean;
  occurrence_date?: string;
}

export const calendarRemindersApi = {
  list: (params?: { start?: string; end?: string; include_done?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.start) q.set("start", params.start);
    if (params?.end) q.set("end", params.end);
    if (params?.include_done !== undefined) q.set("include_done", String(params.include_done));
    return request<CalendarReminderList>(`/calendar/reminders?${q}`);
  },
  create: (body: CalendarReminderCreate) =>
    request<CalendarReminder>("/calendar/reminders", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: CalendarReminderUpdate) =>
    request<CalendarReminder>(`/calendar/reminders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<void>(`/calendar/reminders/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
