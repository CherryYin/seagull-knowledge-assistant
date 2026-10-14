import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, type Project, type TodoResource, type TodoResourceRole } from "@/lib/api/projects";
import type { CalendarReminder } from "@/lib/api/calendar-reminders";
import { invalidateReminderQueries } from "@/lib/reminderQueries";
import { ProjectResourcePicker } from "./ProjectResourcePicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function TaskResources({ task, project }: { task: CalendarReminder; project?: Project }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState<TodoResourceRole | null>(null);
  const [removing, setRemoving] = useState<TodoResource | null>(null);
  const readOnly = !project || Boolean(project.archived_at);
  const resources = useQuery({ queryKey: ["projects", "task-resources", project?.id ?? null, task.id, page],
    queryFn: () => project ? projectsApi.taskResources(project.id, task.id, { limit: 20, offset: page * 20 }) : projectsApi.todoResources(task.id, { limit: 20, offset: page * 20 }) });
  const remove = useMutation({ mutationFn: () => projectsApi.removeTaskResource(project!.id, task.id, removing!.id, project!.revision),
    onSuccess: () => { setRemoving(null); invalidateReminderQueries(queryClient); } });
  useEffect(() => {
    if (resources.data && page > Math.max(0, Math.ceil(resources.data.total / 20) - 1)) setPage(Math.max(0, Math.ceil(resources.data.total / 20) - 1));
  }, [resources.data, page]);
  return <section className="space-y-3 border-t pt-3" aria-label={`Resources for ${task.text}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Task context and results</h3>{!readOnly && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setAdding("context")}>Link context</Button>{task.recurrence === "once" && <Button size="sm" variant="outline" onClick={() => setAdding("result")}>Link result</Button>}</div>}</div>
    <p className="text-xs text-muted-foreground">Explicit links are separate from legacy linked Notes. Results do not automatically complete tasks or establish adoption.</p>
    {resources.isLoading && <p role="status">Loading task resources…</p>}
    {resources.isError && <div role="alert"><p className="text-sm text-destructive">Task resources are unavailable, not empty.</p><Button size="sm" variant="outline" onClick={() => void resources.refetch()}>Retry task resources</Button></div>}
    {resources.data && !resources.isError && <>{resources.data.total === 0 && <p className="text-sm text-muted-foreground">No explicit context or results linked yet.</p>}{resources.data.items.map(item => <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border p-3"><div className="min-w-0"><p className="text-xs text-muted-foreground">{item.role === "context" ? "Context" : "Result"} · {item.resource_type}</p><Link className="break-words text-sm text-primary" to={item.href} state={{ backTo: project ? `/projects/${project.id}?tab=tasks` : "/", backLabel: project ? "Back to Project" : "Back to Home" }}>{item.title}</Link>{item.reason && <p className="break-words text-xs text-muted-foreground">{item.reason}</p>}</div>{!readOnly && <Button size="sm" variant="outline" onClick={() => { remove.reset(); setRemoving(item); }}>Remove task link</Button>}</div>)}{resources.data.total > 20 && <div className="flex justify-between"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous task resources</Button><span className="text-xs">{resources.data.total} links · page {page + 1}</span><Button size="sm" variant="outline" disabled={(page + 1) * 20 >= resources.data.total} onClick={() => setPage(page + 1)}>Next task resources</Button></div>}</>}
    {adding && project && <ProjectResourcePicker project={project} initialType={adding === "result" ? "asset" : "source"} taskId={task.id} role={adding} onClose={() => setAdding(null)} />}
    <Dialog open={Boolean(removing)} onOpenChange={open => { if (!open && !remove.isPending) setRemoving(null); }}><DialogContent><DialogHeader><DialogTitle>Remove this task resource link?</DialogTitle></DialogHeader><p className="text-sm">{removing?.title}</p><p className="text-sm text-muted-foreground">Only this task link is removed. The original content, other task links, and the project resource link remain.</p>{remove.isError && <div role="alert"><p className="text-sm text-destructive">{remove.error.message}</p><Button variant="outline" onClick={() => invalidateReminderQueries(queryClient)}>Refresh task and project</Button></div>}<Button disabled={remove.isPending} onClick={() => remove.mutate()}>Confirm remove task resource</Button></DialogContent></Dialog>
  </section>;
}

export function ProjectResults({ project }: { project: Project }) {
  const [page, setPage] = useState(0);
  const results = useQuery({ queryKey: ["projects", "task-results", project.id, page], queryFn: () => projectsApi.taskResults(project.id, { limit: 5, offset: page * 5 }) });
  useEffect(() => {
    if (results.data && page > Math.max(0, Math.ceil(results.data.total / 5) - 1)) setPage(Math.max(0, Math.ceil(results.data.total / 5) - 1));
  }, [results.data, page]);
  return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">Recent task results</h2><p className="text-sm text-muted-foreground">Explicitly linked Notes and Assets, newest links first. This is not an adoption metric.</p>
    {results.isLoading && <p role="status">Loading task results…</p>}
    {results.isError && <div role="alert"><p>Task results are unavailable, not empty.</p><Button variant="outline" onClick={() => void results.refetch()}>Retry task results</Button></div>}
    {results.data && !results.isError && <>{results.data.total === 0 && <p className="text-sm text-muted-foreground">No task results yet. Link a Note or Asset from Tasks after producing something useful.</p>}{results.data.items.map(item => <div key={item.id} className="rounded-lg border p-3"><Link className="text-sm text-primary" to={item.href} state={{ backTo: `/projects/${project.id}`, backLabel: "Back to Project" }}>{item.title}</Link><p className="text-xs text-muted-foreground">{item.task_text} · {item.task_done ? "Task completed" : "Task still pending"}</p>{item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}</div>)}{results.data.total > 5 && <div className="flex justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous results</Button><span className="text-sm">{results.data.total} result links</span><Button variant="outline" disabled={(page + 1) * 5 >= results.data.total} onClick={() => setPage(page + 1)}>Next results</Button></div>}</>}
  </section>;
}
