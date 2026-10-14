import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ChatMessageSaveReceipt } from "@/lib/api/chat-sessions";
import { projectsApi, type ProjectContextSnapshot } from "@/lib/api/projects";
import { invalidateReminderQueries } from "@/lib/reminderQueries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function SavedResultLinks({ receipt, context }: { receipt: ChatMessageSaveReceipt; context?: ProjectContextSnapshot }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(context?.project_id ?? "");
  const [taskId, setTaskId] = useState(context?.task?.recurrence === "once" && receipt.object_type !== "wiki" ? context.task.id : "");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const resourceType = receipt.object_type === "note" || receipt.object_type === "asset" || receipt.object_type === "wiki" ? receipt.object_type : null;
  const choices = useQuery({ queryKey: ["projects", "saved-result-choices", query, page],
    queryFn: () => projectsApi.list({ query, limit: 10, offset: page * 10 }), enabled: open });
  const selected = useQuery({ queryKey: ["projects", "saved-result-selection", projectId],
    queryFn: () => projectsApi.get(projectId), enabled: open && Boolean(projectId), refetchOnWindowFocus: false });
  const tasks = useQuery({ queryKey: ["projects", "saved-result-tasks", projectId, taskPage],
    queryFn: () => projectsApi.tasks(projectId, { kind: "once", include_done: true, limit: 10, offset: taskPage * 10 }),
    enabled: open && Boolean(projectId) && resourceType !== "wiki" });
  const link = useMutation({
    mutationFn: () => projectsApi.linkSavedResult(projectId, { base_revision: selected.data!.revision,
      resource_type: resourceType!, resource_id: receipt.object_id, reminder_id: taskId || null }),
    onSuccess: saved => {
      queryClient.setQueryData(["projects", "saved-result-selection", projectId], saved.project);
      invalidateReminderQueries(queryClient);
    },
  });
  const chooseProject = (id: string) => { setProjectId(id); setTaskId(""); setTaskPage(0); link.reset(); };
  const label = resourceType === "wiki" ? "Wiki draft" : resourceType === "asset" ? "Asset" : "Note";
  if (!resourceType || !receipt.object_id || receipt.object_id === "saved") return null;
  return <div className="mt-2 space-y-2 rounded-lg border p-3 text-xs">
    <p>Saved {label}: <Link className="text-primary hover:underline" to={`/${resourceType === "wiki" ? "wiki" : `${resourceType}s`}/${encodeURIComponent(receipt.object_id)}`}>{receipt.title || receipt.object_id}</Link></p>
    <Button size="sm" variant="outline" onClick={() => { link.reset(); setOpen(true); }}>Link saved {label} to Project</Button>
    <Dialog open={open} onOpenChange={value => { if (!link.isPending) setOpen(value); }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Link saved result</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <p className="text-sm">{receipt.title || receipt.object_id} · {label}</p>
        <p className="text-xs text-muted-foreground">The content is already saved. Confirming links the same object; it does not create another copy, mark adoption, complete a Todo, or change this Chat’s execution context.</p>
        {context && <p className="text-xs text-muted-foreground">Default selection comes from this message’s recorded Project, not the current Chat scope. Review the destination below.</p>}
        <Input aria-label="Search projects for saved result" placeholder="Search projects" maxLength={200} value={query} disabled={link.isPending} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        {choices.isLoading && <p role="status">Loading project choices…</p>}
        {choices.isError && <div role="alert"><p>Project choices are unavailable, not empty.</p><Button variant="outline" onClick={() => void choices.refetch()}>Retry result project choices</Button></div>}
        {choices.data?.items.map(project => <label key={project.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm"><input type="radio" name={`result-project-${receipt.object_id}`} checked={projectId === project.id} disabled={link.isPending} onChange={() => chooseProject(project.id)} />{project.title}</label>)}
        {choices.data?.total === 0 && <p className="text-sm">No matching projects.</p>}
        {choices.data && choices.data.total > 10 && <div className="flex justify-between"><Button variant="outline" disabled={page === 0 || link.isPending} onClick={() => setPage(page - 1)}>Previous result projects</Button><Button variant="outline" disabled={(page + 1) * 10 >= choices.data.total || link.isPending} onClick={() => setPage(page + 1)}>Next result projects</Button></div>}
        {selected.isLoading && projectId && <p role="status">Loading selected destination…</p>}
        {selected.isError && <p role="alert">Selected project is unavailable. The saved content remains; retry or choose another project.</p>}
        {selected.data && !selected.isError && <p className="text-sm font-medium">Destination: {selected.data.title} · revision {selected.data.revision}{selected.data.archived_at ? " · archived, read-only" : ""}</p>}
        {projectId && resourceType !== "wiki" && <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`result-task-${receipt.object_id}`} checked={!taskId} disabled={link.isPending} onChange={() => { setTaskId(""); link.reset(); }} />Project only — no Todo result</label>
          {taskId && <p className="text-xs">Selected Todo: {tasks.data?.items.find(task => task.id === taskId)?.text ?? (taskId === context?.task?.id ? context.task.text : taskId)}. Membership is checked on confirmation.</p>}
          {tasks.isLoading && <p role="status">Loading one-time Todos…</p>}
          {tasks.isError && <div role="alert"><p>Todo choices are unavailable, not empty.</p><Button variant="outline" onClick={() => void tasks.refetch()}>Retry result Todos</Button></div>}
          {tasks.data?.items.map(task => <label key={task.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm"><input type="radio" name={`result-task-${receipt.object_id}`} checked={taskId === task.id} disabled={link.isPending} onChange={() => { setTaskId(task.id); link.reset(); }} />{task.text}{task.is_done ? " · completed" : " · pending"}</label>)}
          {tasks.data?.total === 0 && <p>No one-time Todos in this project.</p>}
          {tasks.data && tasks.data.total > 10 && <div className="flex justify-between"><Button variant="outline" disabled={taskPage === 0 || link.isPending} onClick={() => setTaskPage(taskPage - 1)}>Previous result Todos</Button><Button variant="outline" disabled={(taskPage + 1) * 10 >= tasks.data.total || link.isPending} onClick={() => setTaskPage(taskPage + 1)}>Next result Todos</Button></div>}
        </div>}
        {resourceType === "wiki" && <p className="text-xs text-muted-foreground">Wiki drafts link to the Project only. Todo results currently support Notes and Assets.</p>}
        {link.isError && <div role="alert"><p className="text-sm text-destructive">Result link was not confirmed. The content is already saved; your destination is retained. Retry links only — do not save another copy.</p><p className="text-xs">{link.error.message}</p></div>}
        {projectId && <Button variant="outline" disabled={link.isPending || selected.isFetching} onClick={() => { link.reset(); void selected.refetch(); if (resourceType !== "wiki") void tasks.refetch(); }}>Refresh result destination</Button>}
        {link.isSuccess && <p role="status">Saved result linked to {link.data.project.title}{link.data.reminder_id ? " and the selected Todo" : ""}. Content and task completion are unchanged.</p>}
        <Button disabled={!resourceType || !selected.data || selected.isError || selected.isFetching || Boolean(selected.data.archived_at) || link.isPending || link.isSuccess || Boolean(taskId && (tasks.isError || tasks.isLoading))} onClick={() => link.mutate()}>{link.isPending ? "Linking existing result…" : "Confirm saved result links"}</Button>
      </div>
    </DialogContent></Dialog>
  </div>;
}
