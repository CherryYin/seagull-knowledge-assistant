import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/lib/api/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ProjectDiagnosticsPicker({ projectId, onChange }: { projectId?: string; onChange: (id?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [archived, setArchived] = useState(false);
  const selected = useQuery({ queryKey: ["projects", "diagnostics-scope", projectId],
    queryFn: () => projectsApi.get(projectId!), enabled: Boolean(projectId) });
  const choices = useQuery({ queryKey: ["projects", "diagnostics-choices", query, archived, page],
    queryFn: () => projectsApi.list({ query, archived, limit: 10, offset: page * 10 }), enabled: open });
  return <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Asset diagnostics Project scope">
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-sm font-medium">{projectId ? `Selected Project: ${selected.data?.title ?? projectId}${selected.data?.archived_at ? " · archived" : ""}` : "Scope: All owned Assets"}</p>
      <Button variant="outline" onClick={() => setOpen(true)}>Choose diagnostic Project</Button>
      {projectId && <Button variant="outline" onClick={() => onChange()}>Show all Assets</Button>}
    </div>
    {selected.isError && projectId && <div role="alert"><p className="text-sm text-destructive">Selected Project is unavailable, not an empty project. Choose another scope or retry.</p><Button variant="outline" onClick={() => void selected.refetch()}>Retry diagnostic Project</Button></div>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Choose Asset diagnostic scope</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <Button variant="outline" onClick={() => { onChange(); setOpen(false); }}>Use global Asset scope</Button>
        <Input aria-label="Search diagnostic Projects" placeholder="Search Projects" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setPage(0); }} />Show archived Projects</label>
        {choices.isLoading && <p role="status">Loading diagnostic Projects…</p>}
        {choices.isError && <div role="alert"><p>Diagnostic Project choices are unavailable, not empty.</p><Button variant="outline" onClick={() => void choices.refetch()}>Retry diagnostic Project choices</Button></div>}
        {choices.data && !choices.isError && <>
          {choices.data.total === 0 && <p>No Projects match these filters.</p>}
          {choices.data.items.map(project => <Button key={project.id} variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" aria-pressed={projectId === project.id} onClick={() => { onChange(project.id); setOpen(false); }}>{project.title} · {project.archived_at ? "archived" : project.status}</Button>)}
          {choices.data.total > 10 && <div className="flex justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous diagnostic Projects</Button><Button variant="outline" disabled={(page + 1) * 10 >= choices.data.total} onClick={() => setPage(page + 1)}>Next diagnostic Projects</Button></div>}
        </>}
      </div>
    </DialogContent></Dialog>
  </section>;
}
