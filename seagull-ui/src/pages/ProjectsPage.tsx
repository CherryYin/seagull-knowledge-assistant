import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban, Plus, RefreshCw } from "lucide-react";
import { projectsApi, type ProjectStatus } from "@/lib/api/projects";
import { ProjectForm } from "@/components/projects/ProjectForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ProjectsPage() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const projects = useQuery({ queryKey: ["projects", "list", status, archived, query, page],
    queryFn: () => projectsApi.list({ status: status ? status as ProjectStatus : undefined, archived, query, offset: page * 20, limit: 20 }) });

  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-3xl font-semibold"><FolderKanban className="h-7 w-7 text-primary" />Projects</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Keep a goal, its knowledge, deliverables, and conversations together. Existing objects stay in their original libraries.</p></div><Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />New Project</Button></header>
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
      <label className="flex-1 text-sm">Search projects<Input className="mt-1" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Project name" /></label>
      <label className="text-sm">Project status<select className="mt-1 block h-10 rounded-md border bg-background px-3" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">All statuses</option><option value="active">Active</option><option value="completed">Completed</option></select></label>
      <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setPage(0); }} />Archived projects</label>
      <Button variant="outline" disabled={projects.isFetching} onClick={() => void projects.refetch()}><RefreshCw className="h-4 w-4" />Refresh projects</Button>
    </div>
    {projects.isLoading && <p role="status" className="rounded-xl border p-8 text-center">Loading projects…</p>}
    {projects.isError && <div role="alert" className="rounded-xl border p-6"><p className="text-destructive">Could not load projects. The list is unavailable, not empty.</p><Button className="mt-3" variant="outline" onClick={() => void projects.refetch()}>Retry projects</Button></div>}
    {projects.data && !projects.isError && <>
      {projects.data.total === 0 && <div className="rounded-xl border border-dashed p-8 text-center"><h2 className="font-semibold">{query || archived || status ? "No matching projects" : "Start with one real goal"}</h2><p className="mt-2 text-sm text-muted-foreground">Create a project, then link the Sources, Notes, Wiki, Assets, and sessions you already use.</p></div>}
      <div className="grid gap-4 md:grid-cols-2">{projects.data.items.map(project => <Link key={project.id} className="space-y-3 rounded-xl border bg-card p-5 transition-colors hover:border-primary/40" to={`/projects/${encodeURIComponent(project.id)}`}><div className="flex items-start justify-between gap-3"><h2 className="break-words font-semibold">{project.title}</h2><Badge variant="outline">{project.archived_at ? "archived" : project.status}</Badge></div><p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{project.goal}</p><p className="text-xs text-muted-foreground">{Object.values(project.resource_counts).reduce((sum, count) => sum + count, 0)} linked objects · updated {new Date(project.updated_at).toLocaleDateString()}</p></Link>)}</div>
      {projects.data.total > 20 && <div className="flex items-center justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous projects</Button><span className="text-sm">{projects.data.total} projects · page {page + 1}</span><Button variant="outline" disabled={(page + 1) * 20 >= projects.data.total} onClick={() => setPage(page + 1)}>Next projects</Button></div>}
    </>}
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Create Project</DialogTitle></DialogHeader>{createOpen && <ProjectForm onSaved={project => navigate(`/projects/${encodeURIComponent(project.id)}`)} />}</DialogContent></Dialog>
  </div></div>;
}
