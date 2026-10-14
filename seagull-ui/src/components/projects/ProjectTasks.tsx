import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { calendarRemindersApi } from "@/lib/api/calendar-reminders";
import { projectsApi, type Project } from "@/lib/api/projects";
import { invalidateReminderQueries } from "@/lib/reminderQueries";
import { TaskForm } from "./TaskForm";
import { TaskRow } from "./TaskRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }

export function ProjectTaskOverview({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const summary = useQuery({ queryKey: ["projects", "tasks-overview", project.id], queryFn: () => projectsApi.tasks(project.id, { limit: 3, include_done: false }) });
  const clear = useMutation({ mutationFn: () => projectsApi.nextTask(project.id, null, project.revision), onSuccess: () => invalidateReminderQueries(queryClient) });
  return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">Next step</h2>
    {summary.isLoading && <p role="status">Loading project actions…</p>}
    {summary.isError && <div role="alert"><p>Project actions are unavailable, not empty.</p><Button variant="outline" onClick={() => void summary.refetch()}>Retry project actions</Button></div>}
    {summary.data && !summary.isError && <><p className="text-sm text-muted-foreground">{summary.data.pending_count ?? 0} pending · {summary.data.completed_count ?? 0} completed one-time actions. This is not a project completion percentage.</p>{summary.data.next_task ? <><TaskRow task={summary.data.next_task} project={project} />{!project.archived_at && <Button variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>Clear next step</Button>}</> : <p className="text-sm text-muted-foreground">No next step selected. Choose an unfinished one-time action in Tasks.</p>}</>}
    {clear.isError && <div role="alert" className="text-sm text-destructive"><p>{clear.error.message}</p><Button variant="outline" onClick={() => invalidateReminderQueries(queryClient)}>Refresh project</Button></div>}
    {summary.data && !summary.isError && <div className="space-y-2"><h3 className="text-sm font-semibold">Pending actions</h3>{summary.data.items.map(task => <p key={task.id} className="text-sm">{task.text} · {task.date ?? "Not scheduled"}</p>)}{summary.data.pending_count === 0 && <p className="text-sm text-muted-foreground">No pending one-time actions. Check your completion criteria before marking the project complete.</p>}<Link className="inline-block text-sm text-primary" to={`/projects/${project.id}?tab=tasks`}>{summary.data.pending_count > 0 ? "Open all tasks and choose your next step" : "Open Tasks to plan an action"}</Link></div>}
  </section>;
}

export function ProjectTasks({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"once" | "recurring">("once");
  const [page, setPage] = useState(0);
  const [includeDone, setIncludeDone] = useState(true);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(() => { const day = new Date(); day.setDate(day.getDate() + 30); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`; });
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [optionPage, setOptionPage] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [revision, setRevision] = useState(project.revision);
  const validRange = kind === "once" || Boolean(start && end && start <= end);
  const tasks = useQuery({ queryKey: ["projects", "tasks", project.id, kind, page, includeDone, start, end], enabled: validRange,
    queryFn: () => projectsApi.tasks(project.id, { kind, start: kind === "recurring" ? start : undefined, end: kind === "recurring" ? end : undefined, include_done: includeDone, limit: 20, offset: page * 20 }) });
  const options = useQuery({ queryKey: ["project-task-options", optionPage], enabled: attaching,
    queryFn: () => calendarRemindersApi.list({ include_unscheduled: true, unassigned_only: true, limit: 20, offset: optionPage * 20 }) });
  const attach = useMutation({ mutationFn: () => projectsApi.attachTask(project.id, selectedId, revision), onSuccess: () => { setAttaching(false); setSelectedId(""); invalidateReminderQueries(queryClient); } });
  const refresh = useMutation({ mutationFn: () => projectsApi.get(project.id), onSuccess: saved => { setRevision(saved.revision); attach.reset(); } });
  useEffect(() => {
    if (tasks.data && page > Math.max(0, Math.ceil(tasks.data.total / 20) - 1)) setPage(Math.max(0, Math.ceil(tasks.data.total / 20) - 1));
  }, [tasks.data, page]);
  return <section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Project actions</h2><div className="flex gap-2"><Button variant="outline" onClick={() => invalidateReminderQueries(queryClient)}>Refresh tasks</Button>{!project.archived_at && <><Button onClick={() => setCreating(true)}>New Task</Button><Button variant="outline" onClick={() => { setRevision(project.revision); attach.reset(); setAttaching(true); }}>Add existing Todo</Button></>}</div></div>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Action type<select className="ml-2 rounded-md border bg-background p-2" value={kind} onChange={event => { setKind(event.target.value as "once" | "recurring"); setPage(0); }}><option value="once">One-time actions</option><option value="recurring">Recurring reminders</option></select></label><label className="text-sm"><input type="checkbox" checked={includeDone} onChange={event => { setIncludeDone(event.target.checked); setPage(0); }} /> Include completed</label>{kind === "recurring" && <><label className="text-sm">From<input type="date" className="ml-2 rounded border bg-background p-2" value={start} onChange={event => { setStart(event.target.value); setPage(0); }} /></label><label className="text-sm">To<input type="date" className="ml-2 rounded border bg-background p-2" value={end} onChange={event => { setEnd(event.target.value); setPage(0); }} /></label></>}</div>
    <p className="text-sm text-muted-foreground">{kind === "once" ? "Dated and unscheduled actions use the same Todos as Home and Calendar." : "Each row is one occurrence in the chosen date range. Recurring reminders are not counted toward one-time task totals."}</p>
    {!validRange && <p role="alert">Choose a valid date range.</p>}
    {tasks.isLoading && <p role="status">Loading tasks…</p>}
    {tasks.isError && <div role="alert"><p>Tasks are unavailable, not empty.</p><Button variant="outline" onClick={() => void tasks.refetch()}>Retry tasks</Button></div>}
    {validRange && tasks.data && !tasks.isError && <>{tasks.data.total === 0 && <p className="rounded-xl border border-dashed p-6 text-muted-foreground">No matching project actions. Start with one concrete next step.</p>}{tasks.data.items.map(task => <TaskRow key={`${task.id}:${task.date}`} task={task} project={project} occurrence={kind === "recurring"} />)}{tasks.data.total > 20 && <div className="flex justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous tasks</Button><span>{tasks.data.total} {kind === "once" ? "tasks" : "occurrences"} · page {page + 1}</span><Button variant="outline" disabled={(page + 1) * 20 >= tasks.data.total} onClick={() => setPage(page + 1)}>Next tasks</Button></div>}</>}
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>Create Project Task</DialogTitle></DialogHeader>{creating && <TaskForm project={project} onSaved={() => setCreating(false)} />}</DialogContent></Dialog>
    <Dialog open={attaching} onOpenChange={value => { if (!attach.isPending) setAttaching(value); }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Add existing Todo</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">Choose an unassigned Todo. Its existing linked notes will also be added to this project as references. Dates, completion state, and note content are preserved.</p>{options.isLoading && <p role="status">Loading available Todos…</p>}{options.isError && <div role="alert"><p>Todos are unavailable.</p><Button variant="outline" onClick={() => void options.refetch()}>Retry available Todos</Button></div>}{options.data?.items.map(task => <label key={task.id} className="flex gap-2 rounded border p-3 text-sm"><input type="radio" name="project-task" checked={selectedId === task.id} onChange={() => { setSelectedId(task.id); attach.reset(); }} />{task.text} · {task.date ?? "Not scheduled"}</label>)}{options.data?.total === 0 && <p>No unassigned Todos.</p>}{options.data && options.data.total > 20 && <div className="flex justify-between"><Button variant="outline" disabled={optionPage === 0} onClick={() => setOptionPage(optionPage - 1)}>Previous available Todos</Button><Button variant="outline" disabled={(optionPage + 1) * 20 >= options.data.total} onClick={() => setOptionPage(optionPage + 1)}>Next available Todos</Button></div>}{(attach.isError || refresh.isError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>Your Todo choice is retained.</p><p>{(attach.error ?? refresh.error)?.message}</p><Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh project revision (keep Todo)</Button></div>}<Button disabled={!selectedId || attach.isPending || refresh.isPending} onClick={() => attach.mutate()}>Confirm add Todo</Button></DialogContent></Dialog>
  </section>;
}
