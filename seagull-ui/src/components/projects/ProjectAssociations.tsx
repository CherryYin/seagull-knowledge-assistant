import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { projectsApi, type Project, type ProjectResourceType } from "@/lib/api/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ProjectAssociations({ resourceType, resourceId }: { resourceType: ProjectResourceType; resourceId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [linkedPage, setLinkedPage] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Project | null>(null);
  const links = useQuery({ queryKey: ["projects", "for-resource", resourceType, resourceId, linkedPage],
    queryFn: () => projectsApi.forResource({ resource_type: resourceType, resource_id: resourceId, limit: 10, offset: linkedPage * 10 }), enabled: open });
  const available = useQuery({ queryKey: ["projects", "picker", query, page],
    queryFn: () => projectsApi.list({ query, limit: 10, offset: page * 10 }), enabled: open });
  const add = useMutation({ mutationFn: () => projectsApi.addResources(selected!.id, selected!.revision, [{ resource_type: resourceType, resource_id: resourceId }]),
    onSuccess: () => { setSelected(null); void queryClient.invalidateQueries({ queryKey: ["projects"] }); } });
  const refresh = useMutation({ mutationFn: () => projectsApi.get(selected!.id), onSuccess: saved => { setSelected(saved); add.reset(); } });

  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}><FolderKanban className="h-4 w-4" />Projects</Button>
    <Dialog open={open} onOpenChange={value => { if (!add.isPending) setOpen(value); }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Projects for this resource</DialogTitle></DialogHeader>
      <div className="space-y-4">
        {links.isLoading && <p role="status">Loading project links…</p>}
        {links.isError && <div role="alert"><p className="text-destructive">Project links are unavailable.</p><Button variant="outline" onClick={() => void links.refetch()}>Retry project links</Button></div>}
        {(links.data?.items ?? []).map(project => <div key={project.id} className="rounded-lg border p-3"><Link className="text-primary hover:underline" to={`/projects/${encodeURIComponent(project.id)}`} onClick={() => setOpen(false)}>{project.title}</Link><p className="text-xs text-muted-foreground">{project.archived_at ? "archived" : project.status}</p></div>)}
        {links.data?.total === 0 && <p className="text-sm text-muted-foreground">Not linked to any project yet.</p>}
        {links.data && links.data.total > 10 && <div className="flex justify-between"><Button variant="outline" disabled={linkedPage === 0} onClick={() => setLinkedPage(linkedPage - 1)}>Previous linked projects</Button><Button variant="outline" disabled={(linkedPage + 1) * 10 >= links.data.total} onClick={() => setLinkedPage(linkedPage + 1)}>Next linked projects</Button></div>}
        <h3 className="font-medium">Add to a project</h3><Input aria-label="Search projects to link" placeholder="Search projects" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        {available.isLoading && <p role="status">Loading projects…</p>}
        {available.isError && <div role="alert"><p className="text-destructive">Could not load projects.</p><Button variant="outline" onClick={() => void available.refetch()}>Retry project choices</Button></div>}
        {(available.data?.items ?? []).map(project => <label key={project.id} className="flex items-center gap-2 rounded-lg border p-3 text-sm"><input type="radio" name="target-project" checked={selected?.id === project.id} onChange={() => { setSelected(project); add.reset(); }} />{project.title}</label>)}
        {available.data?.total === 0 && <p className="text-sm text-muted-foreground">No matching active or completed projects. Create one from <Link className="text-primary" to="/projects">Projects</Link>.</p>}
        {available.data && available.data.total > 10 && <div className="flex justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous project choices</Button><Button variant="outline" disabled={(page + 1) * 10 >= available.data.total} onClick={() => setPage(page + 1)}>Next project choices</Button></div>}
        {(add.isError || refresh.isError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>The link was not confirmed. Your choice is retained.</p><p>{(add.error ?? refresh.error)?.message}</p>{selected && <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh selected project</Button>}</div>}
        {add.isSuccess && <p role="status" className="text-sm text-emerald-700">Project link saved. Original content is unchanged.</p>}
        <Button disabled={!selected || add.isPending || refresh.isPending || Boolean(selected?.archived_at)} onClick={() => add.mutate()}>{add.isPending ? "Linking…" : "Link to selected project"}</Button>
      </div>
    </DialogContent></Dialog>
  </>;
}
