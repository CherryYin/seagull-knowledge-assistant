import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { libraryApi } from "@/lib/api/search";
import { projectsApi, type Project, type ProjectResourceOption, type ProjectResourceType } from "@/lib/api/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const PROJECT_RESOURCE_LABELS: Record<ProjectResourceType, string> = {
  source: "Sources", note: "Notes", wiki: "Wiki", asset: "Assets", chat_session: "Sessions",
};

export function ProjectResourcePicker({ project, initialType, onClose }: {
  project: Project; initialType: ProjectResourceType; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState(initialType);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, ProjectResourceOption>>({});
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(project.revision);
  const options = useQuery({
    queryKey: ["project-resource-options", kind, query, page],
    queryFn: async () => {
      if (kind === "source" || kind === "note" || kind === "wiki") {
        const data = await libraryApi.search({ query, mode: "sql", entity_types: [kind], limit: 20, offset: page * 20 });
        return { total: data.total, items: data.items.map(item => ({ resource_type: item.entity_type, resource_id: item.id,
          title: item.title, href: item.href, status: item.lifecycle_status, updated_at: item.updated_at ?? null })) as ProjectResourceOption[] };
      }
      return projectsApi.options({ resource_type: kind, query, limit: 20, offset: page * 20 });
    },
  });
  const add = useMutation({
    mutationFn: () => projectsApi.addResources(project.id, revision, Object.values(selected).map(item => ({ resource_type: item.resource_type, resource_id: item.resource_id, reason }))),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); onClose(); },
  });
  const refresh = useMutation({ mutationFn: () => projectsApi.get(project.id), onSuccess: saved => { setRevision(saved.revision); add.reset(); } });

  return <Dialog open onOpenChange={open => { if (!open && !add.isPending) onClose(); }}><DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Add existing resources</DialogTitle></DialogHeader>
    <p className="mb-4 text-sm text-muted-foreground">Link existing objects without copying them or automatically adding their references. Selected resources can also belong to other projects.</p>
    <div className="space-y-4">
      <label className="block text-sm">Resource type<select className="mt-1 block w-full rounded-md border bg-background p-2" value={kind} onChange={event => { setKind(event.target.value as ProjectResourceType); setPage(0); setInput(""); setQuery(""); }}>{Object.entries(PROJECT_RESOURCE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(input); setPage(0); }}><Input aria-label="Search project resources" placeholder="Search title" value={input} onChange={event => setInput(event.target.value)} maxLength={200} /><Button type="submit" variant="outline">Search resources</Button></form>
      {options.isLoading && <p role="status">Loading available resources…</p>}
      {options.isError && <div role="alert"><p className="text-destructive">Could not load resources.</p><Button variant="outline" onClick={() => void options.refetch()}>Retry resources</Button></div>}
      <div className="max-h-64 space-y-2 overflow-y-auto">{options.data?.items.map(item => {
        const key = `${item.resource_type}:${item.resource_id}`;
        return <label key={key} className="flex items-start gap-3 rounded-lg border p-3 text-sm"><input type="checkbox" checked={Boolean(selected[key])} disabled={!selected[key] && Object.keys(selected).length >= 50} onChange={event => setSelected(current => {
          const next = { ...current }; if (event.target.checked) next[key] = item; else delete next[key]; return next;
        })} /><span className="min-w-0 break-words">{item.title}<span className="mt-1 block text-xs text-muted-foreground">{PROJECT_RESOURCE_LABELS[item.resource_type]} · {item.status ?? "Unknown state"}</span></span></label>;
      })}{options.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No matching resources.</p>}</div>
      <div className="flex items-center justify-between gap-2"><Button variant="outline" disabled={page === 0 || options.isFetching} onClick={() => setPage(page - 1)}>Previous resources</Button><span className="text-xs">{options.data ? `${options.data.total} available · page ${page + 1}` : "Counts unavailable"}</span><Button variant="outline" disabled={!options.data || (page + 1) * 20 >= options.data.total || options.isFetching} onClick={() => setPage(page + 1)}>Next resources</Button></div>
      <label className="block text-sm">Why these resources belong here (optional)<Input className="mt-1" value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></label>
      {(add.isError || refresh.isError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>No new links were confirmed. Your selection is retained.</p><p>{(add.error ?? refresh.error)?.message}</p><Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh project revision</Button></div>}
      <div className="flex justify-between gap-2"><Button variant="ghost" disabled={add.isPending} onClick={() => setSelected({})}>Clear selection</Button><Button disabled={!Object.keys(selected).length || add.isPending || refresh.isPending} onClick={() => add.mutate()}>{add.isPending ? "Adding…" : `Add selected (${Object.keys(selected).length})`}</Button></div>
    </div>
  </DialogContent></Dialog>;
}
