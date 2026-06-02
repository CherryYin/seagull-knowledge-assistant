import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownRenderer } from "@/components/markdown";
import { wikiApi, type WikiPage, type WikiPageMemoryCreate, type WikiPageSourceCreate, type WikiPageUpdate } from "@/lib/api";

const PAGE_TYPES = ["topic", "entity", "concept", "project", "comparison"];

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function joinCsv(value?: string[]) {
  return (value ?? []).join(", ");
}

function wikiToDraft(page: WikiPage) {
  return {
    title: page.title,
    page_type: page.page_type,
    summary: page.summary ?? "",
    content: page.content ?? "",
    domainsCsv: joinCsv(page.domains),
    tagsCsv: joinCsv(page.tags),
    openQuestionsCsv: joinCsv(page.open_questions),
    confidence: page.confidence_score == null ? "" : String(page.confidence_score),
    needs_recompile: page.needs_recompile,
  };
}

function renderEvidenceList(items?: Array<string | Record<string, unknown>> | null) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      {items.map((item, idx) => (
        <li key={idx}>{typeof item === "string" ? item : JSON.stringify(item)}</li>
      ))}
    </ul>
  );
}

export function WikiDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const backTo = locationState?.backTo || "/wiki";
  const backLabel = locationState?.backLabel || "Back to Wiki";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof wikiToDraft> | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sourceForm, setSourceForm] = useState({
    source_id: "",
    relevance_summary: "",
    key_points: "",
    supporting_claims: "",
    cited_chunk_ids: "",
    confidence_score: "",
  });
  const [memoryForm, setMemoryForm] = useState({
    memory_node_id: "",
    relevance_summary: "",
    key_points: "",
    supporting_claims: "",
    confidence_score: "",
  });

  const { data: page, isLoading, error } = useQuery({
    queryKey: ["wiki-page", id],
    queryFn: () => wikiApi.get(id!),
    enabled: !!id,
  });

  const { data: evidence = [] } = useQuery({
    queryKey: ["wiki-page-sources", id],
    queryFn: () => wikiApi.sources(id!),
    enabled: !!id,
  });

  const { data: memoryEvidence = [] } = useQuery({
    queryKey: ["wiki-page-memories", id],
    queryFn: () => wikiApi.memories(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (page && editing) setDraft(wikiToDraft(page));
  }, [page, editing]);

  const updateMutation = useMutation({
    mutationFn: (payload: WikiPageUpdate) => wikiApi.update(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-page", id] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      setEditing(false);
      setDraft(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => wikiApi.delete(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      navigate(backTo);
    },
  });

  const sourceMutation = useMutation({
    mutationFn: (payload: WikiPageSourceCreate) => wikiApi.upsertSource(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-page", id] });
      queryClient.invalidateQueries({ queryKey: ["wiki-page-sources", id] });
      setSourceOpen(false);
      setSourceForm({
        source_id: "",
        relevance_summary: "",
        key_points: "",
        supporting_claims: "",
        cited_chunk_ids: "",
        confidence_score: "",
      });
    },
  });

  const memoryMutation = useMutation({
    mutationFn: (payload: WikiPageMemoryCreate) => wikiApi.upsertMemory(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-page", id] });
      queryClient.invalidateQueries({ queryKey: ["wiki-page-memories", id] });
      setMemoryOpen(false);
      setMemoryForm({
        memory_node_id: "",
        relevance_summary: "",
        key_points: "",
        supporting_claims: "",
        confidence_score: "",
      });
    },
  });

  function startEdit() {
    if (!page) return;
    setDraft(wikiToDraft(page));
    setEditing(true);
  }

  function saveEdit() {
    if (!draft) return;
    const confidence = draft.confidence.trim() ? Number(draft.confidence) : null;
    updateMutation.mutate({
      title: draft.title,
      page_type: draft.page_type,
      summary: draft.summary,
      content: draft.content,
      domains: splitCsv(draft.domainsCsv),
      tags: splitCsv(draft.tagsCsv),
      open_questions: splitCsv(draft.openQuestionsCsv),
      confidence_score: Number.isFinite(confidence) ? confidence : null,
      needs_recompile: draft.needs_recompile,
    });
  }

  function submitSourceEvidence() {
    sourceMutation.mutate({
      source_id: sourceForm.source_id.trim(),
      relevance_summary: sourceForm.relevance_summary,
      key_points: splitCsv(sourceForm.key_points),
      supporting_claims: splitCsv(sourceForm.supporting_claims),
      cited_chunk_ids: splitCsv(sourceForm.cited_chunk_ids).map(Number).filter(Number.isFinite),
      confidence_score: sourceForm.confidence_score.trim() ? Number(sourceForm.confidence_score) : null,
    });
  }

  function submitMemoryEvidence() {
    memoryMutation.mutate({
      memory_node_id: memoryForm.memory_node_id.trim(),
      relevance_summary: memoryForm.relevance_summary,
      key_points: splitCsv(memoryForm.key_points),
      supporting_claims: splitCsv(memoryForm.supporting_claims),
      confidence_score: memoryForm.confidence_score.trim() ? Number(memoryForm.confidence_score) : null,
    });
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading wiki page…</div>;
  }

  if (error || !page) {
    return (
      <div className="p-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Button>
        <p className="mt-6 text-sm text-destructive">Wiki page not found or failed to load.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          {!editing ? (
            <>
              <Button variant="outline" size="sm" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={saveEdit} disabled={!draft?.title.trim() || updateMutation.isPending}>
                <Save className="h-4 w-4" /> {updateMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0">
            {editing && draft ? (
              <Card>
                <CardHeader>
                  <CardTitle>Edit Wiki Page</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Title</label>
                    <Input value={draft.title} onChange={(event) => setDraft((prev) => prev && { ...prev, title: event.target.value })} className="mt-1" />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        value={draft.page_type}
                        onChange={(event) => setDraft((prev) => prev && { ...prev, page_type: event.target.value })}
                        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        {PAGE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Domains</label>
                      <Input value={draft.domainsCsv} onChange={(event) => setDraft((prev) => prev && { ...prev, domainsCsv: event.target.value })} className="mt-1" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Tags</label>
                      <Input value={draft.tagsCsv} onChange={(event) => setDraft((prev) => prev && { ...prev, tagsCsv: event.target.value })} className="mt-1" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Summary</label>
                    <Textarea value={draft.summary} onChange={(event) => setDraft((prev) => prev && { ...prev, summary: event.target.value })} rows={3} className="mt-1" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Content</label>
                    <Textarea value={draft.content} onChange={(event) => setDraft((prev) => prev && { ...prev, content: event.target.value })} rows={22} className="mt-1 font-mono text-sm" />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Open Questions</label>
                      <Input value={draft.openQuestionsCsv} onChange={(event) => setDraft((prev) => prev && { ...prev, openQuestionsCsv: event.target.value })} className="mt-1" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Confidence 0-1</label>
                      <Input value={draft.confidence} onChange={(event) => setDraft((prev) => prev && { ...prev, confidence: event.target.value })} className="mt-1" />
                    </div>
                  </div>
                  {updateMutation.error && <p className="text-sm text-destructive">{updateMutation.error.message}</p>}
                </CardContent>
              </Card>
            ) : (
              <article className="space-y-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{page.page_type}</Badge>
                    {page.needs_recompile && <Badge>Needs recompile</Badge>}
                    {page.stale_triggered_at && <Badge variant="outline">Stale</Badge>}
                    {page.confidence_score != null && <Badge variant="secondary">confidence {page.confidence_score}</Badge>}
                  </div>
                  <h1 className="mt-3 text-3xl font-semibold tracking-tight">{page.title}</h1>
                  {page.stale_reason && <p className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm leading-6 text-muted-foreground">{page.stale_reason}</p>}
                  {page.summary && <p className="mt-3 text-sm leading-6 text-muted-foreground">{page.summary}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {page.domains.map((domain) => <Badge key={domain} variant="secondary">{domain}</Badge>)}
                    {page.tags.map((tag) => <Badge key={tag} variant="outline">#{tag}</Badge>)}
                  </div>
                </div>

                <Card>
                  <CardContent className="pt-6">
                    <MarkdownRenderer>{page.content || ""}</MarkdownRenderer>
                  </CardContent>
                </Card>
              </article>
            )}
          </main>

          <aside className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Source Evidence</CardTitle>
                <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Source Evidence</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Source ID</label>
                        <Input value={sourceForm.source_id} onChange={(event) => setSourceForm((prev) => ({ ...prev, source_id: event.target.value }))} className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Relevance Summary</label>
                        <Textarea value={sourceForm.relevance_summary} onChange={(event) => setSourceForm((prev) => ({ ...prev, relevance_summary: event.target.value }))} rows={4} className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Key Points</label>
                        <Input value={sourceForm.key_points} onChange={(event) => setSourceForm((prev) => ({ ...prev, key_points: event.target.value }))} placeholder="comma separated" className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Supporting Claims</label>
                        <Input value={sourceForm.supporting_claims} onChange={(event) => setSourceForm((prev) => ({ ...prev, supporting_claims: event.target.value }))} placeholder="comma separated" className="mt-1" />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Chunk IDs</label>
                          <Input value={sourceForm.cited_chunk_ids} onChange={(event) => setSourceForm((prev) => ({ ...prev, cited_chunk_ids: event.target.value }))} placeholder="1, 2, 3" className="mt-1" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Confidence</label>
                          <Input value={sourceForm.confidence_score} onChange={(event) => setSourceForm((prev) => ({ ...prev, confidence_score: event.target.value }))} placeholder="0.8" className="mt-1" />
                        </div>
                      </div>
                      {sourceMutation.error && <p className="text-sm text-destructive">{sourceMutation.error.message}</p>}
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setSourceOpen(false)}>Cancel</Button>
                        <Button onClick={submitSourceEvidence} disabled={!sourceForm.source_id.trim() || !sourceForm.relevance_summary.trim() || sourceMutation.isPending}>
                          {sourceMutation.isPending ? "Saving…" : "Save Evidence"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {evidence.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No source evidence attached yet.</p>
                ) : (
                  <div className="space-y-3">
                    {evidence.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <Link to={`/sources/${encodeURIComponent(item.source_id)}`} className="text-sm font-medium text-primary hover:underline">
                            {item.source_id}
                          </Link>
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.relevance_summary}</p>
                        {renderEvidenceList(item.key_points)}
                        {item.cited_chunk_ids.length > 0 && (
                          <p className="mt-2 text-xs text-muted-foreground">Chunks: {item.cited_chunk_ids.join(", ")}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>


            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Memory Evidence</CardTitle>
                <Dialog open={memoryOpen} onOpenChange={setMemoryOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Memory Evidence</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Memory Node ID</label>
                        <Input value={memoryForm.memory_node_id} onChange={(event) => setMemoryForm((prev) => ({ ...prev, memory_node_id: event.target.value }))} className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Relevance Summary</label>
                        <Textarea value={memoryForm.relevance_summary} onChange={(event) => setMemoryForm((prev) => ({ ...prev, relevance_summary: event.target.value }))} rows={4} className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Key Points</label>
                        <Input value={memoryForm.key_points} onChange={(event) => setMemoryForm((prev) => ({ ...prev, key_points: event.target.value }))} placeholder="comma separated" className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Supporting Claims</label>
                        <Input value={memoryForm.supporting_claims} onChange={(event) => setMemoryForm((prev) => ({ ...prev, supporting_claims: event.target.value }))} placeholder="comma separated" className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Confidence</label>
                        <Input value={memoryForm.confidence_score} onChange={(event) => setMemoryForm((prev) => ({ ...prev, confidence_score: event.target.value }))} placeholder="0.8" className="mt-1" />
                      </div>
                      {memoryMutation.error && <p className="text-sm text-destructive">{memoryMutation.error.message}</p>}
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setMemoryOpen(false)}>Cancel</Button>
                        <Button onClick={submitMemoryEvidence} disabled={!memoryForm.memory_node_id.trim() || !memoryForm.relevance_summary.trim() || memoryMutation.isPending}>
                          {memoryMutation.isPending ? "Saving…" : "Save Evidence"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {memoryEvidence.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No memory evidence attached yet.</p>
                ) : (
                  <div className="space-y-3">
                    {memoryEvidence.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border p-3">
                        <Link to={`/memory?node=${encodeURIComponent(item.memory_node_id)}`} className="text-sm font-medium text-primary hover:underline">
                          {item.memory_node_id}
                        </Link>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.relevance_summary}</p>
                        {renderEvidenceList(item.key_points)}
                        {item.confidence_score != null && (
                          <p className="mt-2 text-xs text-muted-foreground">Confidence: {item.confidence_score}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Provenance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div>
                  <p className="font-medium text-foreground">Derived from notes</p>
                  <p className="mt-1 break-words">{page.derived_from_notes.length ? page.derived_from_notes.join(", ") : "—"}</p>
                </div>
                <div>
                  <p className="font-medium text-foreground">Derived from sources</p>
                  <p className="mt-1 break-words">{page.derived_from_sources.length ? page.derived_from_sources.join(", ") : "—"}</p>
                </div>
                <div>
                  <p className="font-medium text-foreground">Open questions</p>
                  <p className="mt-1">{page.open_questions.length ? page.open_questions.join(", ") : "—"}</p>
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Wiki Page?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This deletes the wiki page and its source evidence. Notes and sources stay unchanged.</p>
          {deleteMutation.error && <p className="text-sm text-destructive">{deleteMutation.error.message}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
