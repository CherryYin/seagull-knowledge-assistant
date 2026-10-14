import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, type Project } from "@/lib/api/projects";
import type { CalendarReminder } from "@/lib/api/calendar-reminders";
import { invalidateReminderQueries } from "@/lib/reminderQueries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function MoveTask({ task, project, onClose }: { task: CalendarReminder; project: Project; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [targetId, setTargetId] = useState("");
  const [sourceRevision, setSourceRevision] = useState(project.revision);
  const options = useQuery({ queryKey: ["projects", "move-options", query, page], queryFn: () => projectsApi.list({ query, limit: 20, offset: page * 20 }) });
  const target = useQuery({ queryKey: ["projects", "move-target", targetId], enabled: Boolean(targetId), queryFn: () => projectsApi.get(targetId) });
  const move = useMutation({ mutationFn: () => projectsApi.updateTask(project.id, task.id, {
    project_id: targetId, base_revision: sourceRevision, target_revision: target.data!.revision,
  }), onSuccess: () => { invalidateReminderQueries(queryClient); onClose(); } });
  const refresh = useMutation({ mutationFn: async () => {
    const source = await projectsApi.get(project.id);
    await target.refetch({ throwOnError: true });
    setSourceRevision(source.revision);
  }, onSuccess: () => { move.reset(); invalidateReminderQueries(queryClient); } });
  return <Dialog open onOpenChange={open => { if (!open && !move.isPending) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Move task to another project</DialogTitle></DialogHeader>
    <p className="text-sm">{task.text}</p><p className="text-sm text-muted-foreground">Currently in {project.title}. The Todo keeps its schedule, completion state, linked Notes, context, and results. Its resource links are also added to the destination project; existing source-project resource links remain.</p>
    {project.next_reminder_id === task.id && <p className="text-sm text-amber-700">This is the current next step. Moving it clears the source project’s next step; it does not select a next step in the destination.</p>}
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(input); setPage(0); }}><Input aria-label="Search destination projects" value={input} maxLength={200} onChange={event => setInput(event.target.value)} /><Button variant="outline" type="submit">Search projects</Button></form>
    {options.isLoading && <p role="status">Loading destination projects…</p>}
    {options.isError && <div role="alert"><p>Destination projects are unavailable.</p><Button variant="outline" onClick={() => void options.refetch()}>Retry destination projects</Button></div>}
    <div className="max-h-48 space-y-2 overflow-y-auto">{options.data?.items.filter(item => item.id !== project.id).map(item => <label key={item.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm"><input type="radio" name="destination-project" value={item.id} checked={targetId === item.id} disabled={move.isPending} onChange={() => { setTargetId(item.id); move.reset(); }} />{item.title} · {item.status}</label>)}</div>
    {options.data && options.data.items.filter(item => item.id !== project.id).length === 0 && <p className="text-sm text-muted-foreground">No other matching projects on this page.</p>}
    <div className="flex justify-between"><Button variant="outline" disabled={page === 0 || options.isFetching} onClick={() => setPage(page - 1)}>Previous projects</Button><Button variant="outline" disabled={!options.data || (page + 1) * 20 >= options.data.total || options.isFetching} onClick={() => setPage(page + 1)}>Next projects</Button></div>
    {targetId && target.isLoading && <p role="status">Loading destination revision…</p>}
    {targetId && target.isError && <div role="alert"><p>Could not load the destination project.</p><Button variant="outline" onClick={() => void target.refetch()}>Retry destination revision</Button></div>}
    {target.data && <p className="text-sm">Destination: {target.data.title}{target.data.archived_at ? " (archived — restore before moving)" : ""}</p>}
    {(move.isError || refresh.isError) && <div role="alert"><p className="text-sm text-destructive">{(move.error ?? refresh.error)?.message}</p><p className="text-sm">Your destination choice is retained. Refresh both projects, then confirm again.</p><Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh both projects</Button></div>}
    <Button disabled={!targetId || !target.data || target.isError || target.isFetching || Boolean(target.data?.archived_at) || move.isPending || refresh.isPending} onClick={() => move.mutate()}>Confirm move task</Button>
  </DialogContent></Dialog>;
}
