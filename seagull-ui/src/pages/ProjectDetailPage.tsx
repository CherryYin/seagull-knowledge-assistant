import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, RefreshCw } from "lucide-react";
import { projectsApi, type Project, type ProjectResource, type ProjectResourceType } from "@/lib/api/projects";
import { ProjectForm } from "@/components/projects/ProjectForm";
import { ProjectTasks, ProjectTaskOverview } from "@/components/projects/ProjectTasks";
import { ProjectResults } from "@/components/projects/TaskResources";
import { ProjectWorkDialog } from "@/components/projects/ProjectWorkDialog";
import { ProjectResourcePicker, PROJECT_RESOURCE_LABELS } from "@/components/projects/ProjectResourcePicker";
import { AssetFunctionalOverview } from "@/components/AssetFunctionalOverview";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab = requested && ["tasks", "knowledge", "outputs", "sessions"].includes(requested) ? requested : "overview";
  const projectQuery = useQuery({ queryKey: ["projects", "detail", id], queryFn: () => projectsApi.get(id) });
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [editSnapshot, setEditSnapshot] = useState<Project | undefined>();
  const [action, setAction] = useState<"complete" | "reopen" | "archive" | "restore" | null>(null);
  const queryClient = useQueryClient();
  const project = projectQuery.data;
  const change = useMutation({ mutationFn: () => {
    if (action === "archive" || action === "restore") return projectsApi.archive(id, project!.revision, action === "restore");
    return projectsApi.update(id, { base_revision: project!.revision, status: action === "complete" ? "completed" : "active" });
  }, onSuccess: () => { setAction(null); void queryClient.invalidateQueries({ queryKey: ["projects"] }); } });

  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
    <Link className="inline-flex items-center gap-2 text-sm text-primary" to="/projects"><ArrowLeft className="h-4 w-4" />Back to Projects</Link>
    {projectQuery.isLoading && <p role="status">Loading project…</p>}
    {projectQuery.isError && <div role="alert" className="rounded-xl border p-6"><p className="text-destructive">This project could not be loaded. It may be unavailable or the API may need updating.</p><Button className="mt-3" variant="outline" onClick={() => void projectQuery.refetch()}>Retry project</Button></div>}
    {project && !projectQuery.isError && <>
      {!project.archived_at && <Button onClick={() => setWorking(true)}>Continue project work</Button>}
      {working && <ProjectWorkDialog projectId={project.id} onClose={() => setWorking(false)} />}
      <header className="space-y-4 rounded-xl border bg-card p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h1 className="break-words text-3xl font-semibold">{project.title}</h1><Badge className="mt-3" variant="outline">{project.archived_at ? "archived" : project.status}</Badge></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={projectQuery.isFetching} onClick={() => void projectQuery.refetch()}><RefreshCw className="h-4 w-4" />Refresh project</Button>{!project.archived_at && <Button variant="outline" onClick={() => { setEditSnapshot(project); setEditing(true); }}><Pencil className="h-4 w-4" />Edit Project</Button>}<Button variant="outline" onClick={() => { change.reset(); setAction(project.archived_at ? "restore" : "archive"); }}>{project.archived_at ? "Restore Project" : "Archive Project"}</Button>{!project.archived_at && <Button onClick={() => { change.reset(); setAction(project.status === "active" ? "complete" : "reopen"); }}>{project.status === "active" ? "Mark Complete" : "Reopen Project"}</Button>}</div></div><p className="whitespace-pre-wrap text-sm">{project.goal}</p>{project.archived_at && <p className="text-sm text-muted-foreground">Archived projects are read-only here. Linked content and existing reminders remain independent and unchanged.</p>}</header>
      <Tabs value={tab} activationMode="manual" onValueChange={value => { const next = new URLSearchParams(searchParams); if (value === "overview") next.delete("tab"); else next.set("tab", value); setSearchParams(next); }}>
        <TabsList className="h-auto max-w-full justify-start overflow-x-auto"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="tasks">Tasks</TabsTrigger><TabsTrigger value="knowledge">Knowledge</TabsTrigger><TabsTrigger value="outputs">Outputs</TabsTrigger><TabsTrigger value="sessions">Sessions</TabsTrigger></TabsList>
        <TabsContent value="tasks" className="h-auto"><ProjectTasks key={project.id} project={project} /></TabsContent>
        <TabsContent value="overview" className="h-auto space-y-6"><section className="rounded-xl border bg-card p-5"><h2 className="font-semibold">Completion criteria</h2><p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{project.completion_criteria || "Not defined yet. Add criteria before deciding whether the goal is complete."}</p></section><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["Materials", project.resource_counts.source ?? 0], ["Knowledge", (project.resource_counts.note ?? 0) + (project.resource_counts.wiki ?? 0)], ["Outputs", project.resource_counts.asset ?? 0], ["Sessions", project.resource_counts.chat_session ?? 0]].map(([label, count]) => <div key={label} className="rounded-xl border p-5"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold">{count}</p></div>)}</div><ProjectTaskOverview project={project} /><ProjectResults project={project} /><p className="text-sm text-muted-foreground">Linked-object counts are not a completion percentage. Project memory and automatic result linking come later.</p><p className="text-xs text-muted-foreground">Project revision {project.revision} · updated {new Date(project.updated_at).toLocaleString()}</p></TabsContent>
        <TabsContent value="knowledge" className="h-auto"><ProjectResourcesPanel project={project} types={["source", "note", "wiki"]} /></TabsContent>
        <TabsContent value="outputs" className="h-auto space-y-6"><ProjectResourcesPanel project={project} types={["asset"]} /><ProjectOutputDiagnostics project={project} /></TabsContent>
        <TabsContent value="sessions" className="h-auto"><ProjectResourcesPanel project={project} types={["chat_session"]} /></TabsContent>
      </Tabs>
      <Dialog open={editing} onOpenChange={setEditing}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Edit Project</DialogTitle></DialogHeader>{editing && <ProjectForm project={editSnapshot} onSaved={() => setEditing(false)} />}</DialogContent></Dialog>
      <Dialog open={Boolean(action)} onOpenChange={open => { if (!open && !change.isPending) setAction(null); }}><DialogContent><DialogHeader><DialogTitle>{action === "complete" ? "Mark this project complete?" : action === "reopen" ? "Reopen this project?" : action === "restore" ? "Restore this project?" : "Archive this project?"}</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">{action === "complete" ? "Confirm against your goal and completion criteria. This does not complete Todos, approve Assets, or establish adoption." : action === "archive" ? "Only the project is archived. Linked knowledge, Assets, conversations, and reminders are not deleted or stopped." : "This changes only the project lifecycle, not its linked content."}</p>{action === "complete" && !project.completion_criteria && <p className="mt-3 text-sm text-amber-700">Completion criteria have not been defined.</p>}{change.isError && <div role="alert" className="mt-3 space-y-2 text-sm text-destructive"><p>{change.error.message}</p><Button variant="outline" disabled={projectQuery.isFetching} onClick={() => void projectQuery.refetch()}>Load current project</Button></div>}<Button className="mt-4" disabled={change.isPending || projectQuery.isFetching} onClick={() => change.mutate()}>{change.isPending ? "Updating…" : "Confirm project change"}</Button></DialogContent></Dialog>
    </>}
  </div></div>;
}

function ProjectOutputDiagnostics({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return <section className="space-y-3">
    <Link className="text-sm text-primary hover:underline" to={`/stats?${new URLSearchParams({ tab: "assets", project_id: project.id })}`}>Open this Project’s Asset diagnostics in Settings Dashboard</Link>
    <details className="rounded-xl border bg-card p-4" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer font-semibold">Asset diagnostics for this Project</summary>
      <p className="my-4 text-sm text-muted-foreground">Read-only diagnostics use the same statistics as Settings Dashboard. All linked Assets are covered, including those beyond the resource list’s current page. This does not measure Project progress or result adoption.</p>
      {open && <AssetFunctionalOverview key={project.id} projectId={project.id} />}
    </details>
  </section>;
}

function ProjectResourcesPanel({ project, types }: { project: Project; types: ProjectResourceType[] }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState(types[0]);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectResource | null>(null);
  const resources = useQuery({ queryKey: ["projects", "resources", project.id, kind, page],
    queryFn: () => projectsApi.resources(project.id, { resource_type: kind, limit: 20, offset: page * 20 }) });
  const remove = useMutation({ mutationFn: () => projectsApi.removeResource(project.id, removing!.id, project.revision),
    onSuccess: () => { setRemoving(null); void queryClient.invalidateQueries({ queryKey: ["projects"] }); } });

  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">{types.length > 1 ? <label className="text-sm">Knowledge type<select className="ml-2 rounded-md border bg-background p-2" value={kind} onChange={event => { setKind(event.target.value as ProjectResourceType); setPage(0); }}>{types.map(type => <option key={type} value={type}>{PROJECT_RESOURCE_LABELS[type]} ({project.resource_counts[type] ?? 0})</option>)}</select></label> : <h2 className="text-xl font-semibold">{PROJECT_RESOURCE_LABELS[kind]}</h2>}<div className="flex gap-2"><Button variant="outline" disabled={resources.isFetching} onClick={() => void resources.refetch()}>Refresh links</Button>{!project.archived_at && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add existing resources</Button>}</div></div>
    {kind === "chat_session" && <p className="text-sm text-muted-foreground">Open existing history. Linking a session does not change its Workflow or execution context. Use Continue project work to start a new conversation with confirmed Project context.</p>}
    {resources.isLoading && <p role="status">Loading linked resources…</p>}
    {resources.isError && <div role="alert" className="rounded-xl border p-5"><p className="text-destructive">Linked resources are unavailable, not empty.</p><Button className="mt-3" variant="outline" onClick={() => void resources.refetch()}>Retry linked resources</Button></div>}
    {resources.data && !resources.isError && <>
      {resources.data.total === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">No linked {PROJECT_RESOURCE_LABELS[kind].toLowerCase()} yet. Add existing objects without moving or copying them.</p>}
      <div className="space-y-3">{resources.data.items.map(item => <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4"><div className="min-w-0"><Link className="break-words font-medium text-primary hover:underline" to={item.href} state={{ backTo: `/projects/${project.id}?tab=${kind === "asset" ? "outputs" : kind === "chat_session" ? "sessions" : "knowledge"}`, backLabel: "Back to Project" }}>{item.title}</Link><p className="mt-1 text-xs text-muted-foreground">{item.status ?? "Unknown state"}{item.updated_at ? ` · updated ${new Date(item.updated_at).toLocaleDateString()}` : ""}</p>{item.reason && <p className="mt-2 break-words text-sm text-muted-foreground">{item.reason}</p>}</div>{!project.archived_at && <Button size="sm" variant="outline" onClick={() => { remove.reset(); setRemoving(item); }}>Remove link</Button>}</div>)}</div>
      {resources.data.total > 20 && <div className="flex items-center justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous linked resources</Button><span className="text-sm">{resources.data.total} linked objects · page {page + 1}</span><Button variant="outline" disabled={(page + 1) * 20 >= resources.data.total} onClick={() => setPage(page + 1)}>Next linked resources</Button></div>}
    </>}
    {adding && <ProjectResourcePicker project={project} initialType={kind} onClose={() => setAdding(false)} />}
    <Dialog open={Boolean(removing)} onOpenChange={open => { if (!open && !remove.isPending) setRemoving(null); }}><DialogContent><DialogHeader><DialogTitle>Remove this project link?</DialogTitle></DialogHeader><p className="text-sm">{removing?.title}</p><p className="mt-2 text-sm text-muted-foreground">Only the association is removed. The original object and other projects’ links remain intact.</p>{remove.isError && <div role="alert" className="mt-3 space-y-2 text-sm text-destructive"><p>{remove.error.message}</p><Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: ["projects"] })}>Load current project links</Button></div>}<Button className="mt-4" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "Removing…" : "Confirm remove link"}</Button></DialogContent></Dialog>
  </section>;
}
