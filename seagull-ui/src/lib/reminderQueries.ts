import type { QueryClient } from "@tanstack/react-query";

export function invalidateReminderQueries(queryClient: QueryClient) {
  for (const key of ["projects", "calendar-reminders", "calendar-reminders-overdue", "home-reminders", "completed-todos", "unscheduled-todos", "project-task-options"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}
