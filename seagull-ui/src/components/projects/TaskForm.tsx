import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { calendarRemindersApi, type CalendarReminder, type CalendarReminderUpdate } from "@/lib/api/calendar-reminders";
import { projectsApi, type Project } from "@/lib/api/projects";
import { invalidateReminderQueries } from "@/lib/reminderQueries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function TaskForm({ project, task, onSaved }: { project?: Project; task?: CalendarReminder; onSaved: () => void }) {
  const [snapshot] = useState(task);
  const queryClient = useQueryClient();
  const [text, setText] = useState(task?.text ?? "");
  const [date, setDate] = useState(task?.date ?? "");
  const [recurrence, setRecurrence] = useState<CalendarReminder["recurrence"]>(task?.recurrence ?? "once");
  const [revision, setRevision] = useState(project?.revision ?? 1);
  const [loaded, setLoaded] = useState(false);
  const save = useMutation({ mutationFn: () => {
    if (task) {
      const changes: CalendarReminderUpdate = {};
      if (text.trim() !== snapshot!.text) changes.text = text.trim();
      if ((date || null) !== snapshot!.date) changes.date = date || null;
      if (recurrence !== snapshot!.recurrence) changes.recurrence = recurrence;
      return project ? projectsApi.updateTask(project.id, task.id, { ...changes, base_revision: revision }) : calendarRemindersApi.update(task.id, changes);
    }
    const body = { text: text.trim(), date: date || null, recurrence };
    return project ? projectsApi.createTask(project.id, { ...body, base_revision: revision }) : calendarRemindersApi.create(body);
  }, onSuccess: () => { invalidateReminderQueries(queryClient); onSaved(); } });
  const refresh = useMutation({ mutationFn: () => projectsApi.get(project!.id), onSuccess: saved => { setRevision(saved.revision); setLoaded(true); save.reset(); } });
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    <label className="block space-y-1 text-sm">Task description<Textarea value={text} onChange={event => setText(event.target.value)} maxLength={1000} required /></label>
    <label className="block space-y-1 text-sm">Scheduled date (optional for one-time tasks)<Input type="date" value={date} onChange={event => setDate(event.target.value)} required={recurrence !== "once"} /></label>
    <label className="block space-y-1 text-sm">Repeat<select className="block w-full rounded-md border bg-background p-2" value={recurrence} onChange={event => setRecurrence(event.target.value as CalendarReminder["recurrence"])}><option value="once">One-time action</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option></select></label>
    <p className="text-sm text-muted-foreground">No date means not scheduled, not today. Dated tasks share the existing Calendar; recurring reminders are completed one occurrence at a time.</p>
    {loaded && <p className="text-sm">Latest project revision loaded; your edits are retained. Review before retrying.</p>}
    {(save.isError || refresh.isError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>Task was not confirmed. Your edits are retained.</p><p>{(save.error ?? refresh.error)?.message}</p>{project && <Button type="button" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Load latest project revision (keep task edits)</Button>}</div>}
    <Button type="submit" disabled={!text.trim() || (recurrence !== "once" && !date) || save.isPending || refresh.isPending}>{save.isPending ? "Saving task…" : task ? "Save Task" : "Create Task"}</Button>
  </form>;
}
