import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { calendarRemindersApi } from "@/lib/api/calendar-reminders";
import { TaskForm } from "./TaskForm";
import { TaskRow } from "./TaskRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function UnscheduledTodos({ completed = false, start, end }: { completed?: boolean; start?: string; end?: string }) {
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({ queryKey: ["unscheduled-todos", completed, start, end, page],
    queryFn: () => calendarRemindersApi.list({ unscheduled_only: true, include_done: completed, completed_only: completed,
      completion_start: completed ? start : undefined, completion_end: completed ? end : undefined, limit: 20, offset: page * 20 }) });
  const known = (tasks.data?.items ?? []).filter(task => !completed || task.completed_at);
  useEffect(() => {
    if (tasks.data && page > Math.max(0, Math.ceil(tasks.data.total / 20) - 1)) setPage(Math.max(0, Math.ceil(tasks.data.total / 20) - 1));
  }, [tasks.data, page]);
  const unknown = completed ? (tasks.data?.items ?? []).filter(task => !task.completed_at) : [];
  return <section className="space-y-4 rounded-xl border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{completed ? "Completed unscheduled Todos" : "Unscheduled Todos"}</h2>{!completed && <Button variant="outline" onClick={() => setCreating(true)}>Add unscheduled Todo</Button>}</div><p className="text-sm text-muted-foreground">{completed ? "Known completion times are filtered by the selected UTC date range. Unknown times are listed separately and are not counted as completions on a particular day." : "Not scheduled does not mean today. These include tasks removed from projects; complete them here or edit them to arrange a date."}</p>
    {tasks.isLoading && <p role="status">Loading unscheduled Todos…</p>}{tasks.isError && <div role="alert"><p>Unscheduled Todos are unavailable, not empty.</p><Button variant="outline" onClick={() => void tasks.refetch()}>Retry unscheduled Todos</Button></div>}
    {tasks.data && !tasks.isError && <>{tasks.data.total === 0 && <p className="text-sm text-muted-foreground">No matching unscheduled Todos.</p>}{known.map(task => <TaskRow key={task.id} task={task} />)}{unknown.length > 0 && <section className="space-y-3"><h3 className="font-medium">Completion time unknown</h3>{unknown.map(task => <TaskRow key={task.id} task={task} />)}</section>}{tasks.data.total > 20 && <div className="flex justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous unscheduled Todos</Button><span className="text-sm">{tasks.data.total} matching tasks{completed ? " (including unknown times)" : ""}</span><Button variant="outline" disabled={(page + 1) * 20 >= tasks.data.total} onClick={() => setPage(page + 1)}>Next unscheduled Todos</Button></div>}</>}
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>Create Todo</DialogTitle></DialogHeader>{creating && <TaskForm onSaved={() => setCreating(false)} />}</DialogContent></Dialog>
  </section>;
}
