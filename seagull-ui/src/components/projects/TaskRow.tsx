import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { calendarRemindersApi, type CalendarReminder } from "@/lib/api/calendar-reminders";
import { projectsApi, type Project } from "@/lib/api/projects";
import { invalidateReminderQueries } from "@/lib/reminderQueries";
import { TaskForm } from "./TaskForm";
import { TaskResources } from "./TaskResources";
import { MoveTask } from "./MoveTask";
import { ProjectWorkDialog } from "./ProjectWorkDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function TaskRow({ task, project, occurrence = false }: { task: CalendarReminder; project?: Project; occurrence?: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [working, setWorking] = useState(false);
  const readOnly = Boolean(project?.archived_at);
  const change = useMutation({ mutationFn: async (action: "complete" | "next" | "detach") => {
    if (action === "next") return projectsApi.nextTask(project!.id, task.id, project!.revision);
    if (action === "detach") return projectsApi.detachTask(project!.id, task.id, project!.revision);
    const body = { is_done: !task.is_done, ...(occurrence && task.date ? { occurrence_date: task.date } : {}) };
    return project ? projectsApi.updateTask(project.id, task.id, { ...body, base_revision: project.revision }) : calendarRemindersApi.update(task.id, body);
  }, onSuccess: () => { setRemoving(false); invalidateReminderQueries(queryClient); } });
  return <div className="space-y-3 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className={`break-words font-medium ${task.is_done ? "text-muted-foreground line-through" : ""}`}>{task.text}</p><p className="mt-1 text-xs text-muted-foreground">{task.date ?? "Not scheduled"} · {task.recurrence === "once" ? "One-time action" : `${task.recurrence} occurrence`}{project?.next_reminder_id === task.id ? " · Next step" : ""}</p>{task.is_done && task.recurrence === "once" && <p className="mt-1 text-xs text-muted-foreground">{task.completed_at ? `Completed ${new Date(task.completed_at).toLocaleString()}` : "Completion time unknown"}</p>}
      {!project && task.project_id && <Link className="mt-2 inline-block text-sm text-primary" to={`/projects/${encodeURIComponent(task.project_id)}?tab=tasks`}>Open project</Link>}
      {(task.linked_notes ?? []).map(note => <Link key={note.id} className="ml-3 text-sm text-primary" to={`/notes/${encodeURIComponent(note.id)}`}>{note.title}</Link>)}</div>
      {!readOnly && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate("complete")}>{task.is_done ? "Reopen task" : occurrence ? "Complete occurrence" : "Complete task"}</Button>{!occurrence && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit task</Button>}{project && !task.is_done && task.recurrence === "once" && project.next_reminder_id !== task.id && <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate("next")}>Make next step</Button>}{project && <Button size="sm" variant="outline" onClick={() => { change.reset(); setRemoving(true); }}>Remove from project</Button>}</div>}
    </div>
    <Button size="sm" variant="ghost" onClick={() => setShowResources(value => !value)}>{showResources ? "Hide task resources" : "Task context and results"}</Button>
    {project && !readOnly && <Button size="sm" variant="ghost" onClick={() => setMoving(true)}>Move to another project</Button>}
    {showResources && <TaskResources task={task} project={project} />}
    {moving && project && <MoveTask task={task} project={project} onClose={() => setMoving(false)} />}
    {project && !readOnly && !task.is_done && !occurrence && <Button size="sm" variant="ghost" onClick={() => setWorking(true)}>Work on this task</Button>}
    {working && project && <ProjectWorkDialog projectId={project.id} reminderId={task.id} onClose={() => setWorking(false)} />}
    {change.isError && !removing && <div role="alert" className="text-sm text-destructive"><p>{change.error.message}</p><Button size="sm" variant="outline" onClick={() => { change.reset(); invalidateReminderQueries(queryClient); }}>Refresh task and project</Button></div>}
    <Dialog open={editing} onOpenChange={setEditing}><DialogContent><DialogHeader><DialogTitle>Edit Task</DialogTitle></DialogHeader>{editing && <TaskForm task={task} project={project} onSaved={() => setEditing(false)} />}</DialogContent></Dialog>
    <Dialog open={removing} onOpenChange={value => { if (!change.isPending) setRemoving(value); }}><DialogContent><DialogHeader><DialogTitle>Remove task from this project?</DialogTitle></DialogHeader><p className="text-sm">The Todo, its linked Notes, context, results, and calendar schedule remain. Project resource links remain too. Unscheduled tasks stay available on Home. Recurring reminders continue on their existing schedule.</p>{change.isError && <div role="alert" className="text-sm text-destructive"><p>{change.error.message}</p><Button variant="outline" onClick={() => invalidateReminderQueries(queryClient)}>Load current project</Button></div>}<Button disabled={change.isPending} onClick={() => change.mutate("detach")}>Confirm remove task</Button></DialogContent></Dialog>
  </div>;
}
