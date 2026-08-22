import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Copy, ExternalLink, Pencil, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownRenderer } from "@/components/markdown";
import { wikiApi, type ReferenceRead, type WikiPage, type WikiPageUpdate } from "@/lib/api";
import { getWikiOrigin, getWikiRole } from "@/lib/wikiLifecycle";
import { buildAssetHandoffState } from "@/lib/asset-handoff";

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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 border-t border-border/60 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="text-sm leading-6 text-foreground/90">{value || "—"}</div>
    </div>
  );
}

function slugifyHeading(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-");
}

function extractToc(content: string) {
  return content
    .split("\n")
    .map((line) => line.match(/^(##|###)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      level: match![1] === "##" ? 2 : 3,
      title: match![2].trim(),
      id: slugifyHeading(match![2].trim()),
    }));
}

export function WikiDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string; flashMessage?: string } | null;
  const backTo = locationState?.backTo || "/wiki";
  const backLabel = locationState?.backLabel || "Back to Wiki";
  const flashMessage = locationState?.flashMessage || null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof wikiToDraft> | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: page, isLoading, error } = useQuery({
    queryKey: ["wiki-page", id],
    queryFn: () => wikiApi.get(id!),
    enabled: !!id,
  });

  const referenceInputs = useMemo(
    () => [
      ...(page?.derived_from_notes ?? []).map((ref_id) => ({ ref_type: "note", ref_id })),
      ...(page?.derived_from_sources ?? []).map((ref_id) => ({ ref_type: "source", ref_id })),
    ],
    [page?.derived_from_notes, page?.derived_from_sources]
  );

  const { data: resolvedReferences = [] } = useQuery({
    queryKey: ["wiki-detail-references", id, referenceInputs],
    queryFn: async () => (referenceInputs.length ? (await wikiApi.resolveReferences(referenceInputs)).items : []),
    enabled: !!id && referenceInputs.length > 0,
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

  const cloneDraftMutation = useMutation({
    mutationFn: () => wikiApi.cloneDraft(id!),
    onSuccess: (draftPage) => {
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      navigate(`/wiki/${encodeURIComponent(draftPage.id)}`, { state: { backTo: `/wiki/${encodeURIComponent(page?.id || id!)}`, backLabel: "Back to Wiki" } });
    },
  });

  const origin = page ? getWikiOrigin(page) : null;
  const role = page ? getWikiRole(page) : "draft";
  const referencesCount = referenceInputs.length;
  const tocItems = useMemo(() => extractToc(page?.content || ""), [page?.content]);
  const stableReadiness = useMemo(() => {
    if (role !== "stable") {
      return referencesCount > 0
        ? { level: "ok", message: `Draft records ${referencesCount} explicit provenance reference${referencesCount === 1 ? "" : "s"}.` }
        : { level: "caution", message: "Draft has no explicit Note or Source provenance yet." };
    }
    return referencesCount > 0
      ? { level: "ok", message: `Stable page records ${referencesCount} explicit provenance reference${referencesCount === 1 ? "" : "s"}.` }
      : { level: "warning", message: "This stable page has no explicit Note or Source provenance." };
  }, [role, referencesCount]);

  const resolvedReferenceMap = useMemo(
    () => new Map(resolvedReferences.map((item) => [`${item.ref_type}:${item.ref_id}`, item] satisfies [string, ReferenceRead])),
    [resolvedReferences]
  );

  const metadataLine = useMemo(() => {
    if (!page) return [] as string[];
    return [page.page_type, role, origin, page.needs_recompile ? "needs recompile" : null, page.stale_triggered_at ? "stale" : null]
      .filter(Boolean) as string[];
  }, [origin, page, role]);

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
    <div className="h-full overflow-y-auto bg-[#f8f9fa] text-foreground dark:bg-background">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          {!editing ? (
            <>
              <Button variant="outline" size="sm" onClick={startEdit}><Pencil className="h-4 w-4" /> Edit</Button>
              {role === "stable" && (
                <Button variant="outline" size="sm" onClick={() => cloneDraftMutation.mutate()} disabled={cloneDraftMutation.isPending}>
                  <Copy className="h-4 w-4" /> {cloneDraftMutation.isPending ? "Cloning…" : "Clone as Draft"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/chat", {
                  state: {
                    objectRef: { object_type: "wiki", object_id: page.id, title: page.title },
                    workflowId: "draft-wiki-refresh",
                    promptSeed: `Use wiki page "${page.title}" (${page.id}) to help me review its current canonical knowledge, inspect gaps, and propose the next draft/update/action without auto-applying changes.`,
                  },
                })}
              >
                <Bot className="h-4 w-4" /> Ask Agent
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/assets", {
                  state: {
                    assetHandoff: buildAssetHandoffState({
                      title: page.title,
                      brief: `Create a blog asset from wiki: ${page.title}`,
                      wiki_refs: [page.id],
                      source_refs: page.derived_from_sources,
                      note_refs: page.derived_from_notes,
                    }),
                  },
                })}
              >
                <ExternalLink className="h-4 w-4" /> Create Asset
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/assets", {
                  state: {
                    assetHandoff: buildAssetHandoffState({
                      title: `${page.title} Brief`,
                      brief: `Create a research brief from wiki: ${page.title}`,
                      asset_type: "research_brief",
                      wiki_refs: [page.id],
                      source_refs: page.derived_from_sources,
                      note_refs: page.derived_from_notes,
                    }),
                  },
                })}
              >
                <ExternalLink className="h-4 w-4" /> Create Brief
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/assets", {
                  state: {
                    assetHandoff: buildAssetHandoffState({
                      title: `${page.title} Pack`,
                      brief: `Create a knowledge pack from wiki: ${page.title}`,
                      asset_type: "knowledge_pack",
                      wiki_refs: [page.id],
                      source_refs: page.derived_from_sources,
                      note_refs: page.derived_from_notes,
                    }),
                  },
                })}
              >
                <ExternalLink className="h-4 w-4" /> Create Pack
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/assets", {
                  state: {
                    assetHandoff: buildAssetHandoffState({
                      title: `${page.title} Issue`,
                      brief: `Create a newsletter issue from wiki: ${page.title}`,
                      asset_type: "newsletter_issue",
                      wiki_refs: [page.id],
                      source_refs: page.derived_from_sources,
                      note_refs: page.derived_from_notes,
                    }),
                  },
                })}
              >
                <ExternalLink className="h-4 w-4" /> Create Newsletter
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/assets", {
                  state: {
                    assetHandoff: buildAssetHandoffState({
                      title: `${page.title} Report`,
                      brief: `Create a topic report from wiki: ${page.title}`,
                      asset_type: "topic_report",
                      wiki_refs: [page.id],
                      source_refs: page.derived_from_sources,
                      note_refs: page.derived_from_notes,
                    }),
                  },
                })}
              >
                <ExternalLink className="h-4 w-4" /> Create Report
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

        {editing && draft ? (
          <Card className="border-border/70 shadow-sm">
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
                  <select value={draft.page_type} onChange={(event) => setDraft((prev) => prev && { ...prev, page_type: event.target.value })} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
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
                <Textarea value={draft.content} onChange={(event) => setDraft((prev) => prev && { ...prev, content: event.target.value })} rows={24} className="mt-1 font-mono text-sm" />
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
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
            <main className="min-w-0 border-b border-border/50 bg-background pb-8 xl:border-b-0 xl:border-r xl:pr-8">
              <div className="mb-3 border-b border-border/60 pb-2">
                <h1 className="text-[2rem] font-normal leading-tight tracking-tight text-foreground">{page.title}</h1>
              </div>
              <div className="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {metadataLine.map((item) => (
                  <span key={item} className="after:ml-2 after:text-muted-foreground/50 after:content-['•'] last:after:content-['']">{item}</span>
                ))}
                {page.confidence_score != null && <span>confidence {page.confidence_score}</span>}
              </div>

              {flashMessage && (
                <div className="mb-6 rounded-sm border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-foreground/90">
                  {flashMessage}
                </div>
              )}

              {page.summary && (
                <div className="mb-8 border-l-4 border-primary/30 bg-muted/20 px-4 py-3 text-[15px] leading-8 text-foreground/85">
                  {page.summary}
                </div>
              )}

              {page.stale_reason && (
                <div className="mb-6 rounded-sm border border-amber-300/50 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
                  {page.stale_reason}
                </div>
              )}

              <div className={`mb-6 rounded-sm border px-4 py-3 text-sm leading-6 ${stableReadiness.level === "warning" ? "border-amber-300/50 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200" : stableReadiness.level === "caution" ? "border-yellow-300/50 bg-yellow-50 text-yellow-900 dark:border-yellow-900/40 dark:bg-yellow-950/20 dark:text-yellow-200" : "border-emerald-300/50 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200"}`}>
                <span className="font-medium">Stable readiness:</span> {stableReadiness.message}
              </div>

              {tocItems.length > 0 && (
                <section className="mb-8 w-fit min-w-[260px] border border-border/70 bg-muted/10 px-4 py-3 text-sm">
                  <p className="font-semibold text-foreground">Contents</p>
                  <ol className="mt-3 space-y-1.5 text-muted-foreground">
                    {tocItems.map((item, index) => (
                      <li key={`${item.id}-${index}`} className={item.level === 3 ? "pl-4" : ""}>
                        <a href={`#${item.id}`} className="hover:text-primary hover:underline">
                          {index + 1}. {item.title}
                        </a>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <article className="prose prose-neutral max-w-none dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-h2:border-b prose-h2:border-border/60 prose-h2:pb-1 prose-h2:text-[1.5rem] prose-h3:text-[1.2rem] prose-p:text-[15px] prose-p:leading-8 prose-li:text-[15px] prose-li:leading-7 prose-table:text-sm prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground prose-pre:rounded-none prose-pre:border prose-pre:border-border prose-a:text-primary [&_h2]:scroll-mt-24 [&_h3]:scroll-mt-24">
                <MarkdownRenderer>{page.content || ""}</MarkdownRenderer>
              </article>

              <section className="mt-12 space-y-6">
                <div>
                  <h2 className="border-b border-border/60 pb-1 text-2xl font-semibold tracking-tight">References</h2>
                  {referencesCount === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">No Note or Source provenance recorded yet.</p>
                  ) : (
                    <ol className="mt-4 space-y-4 pl-5 text-sm">
                      {referenceInputs.map((item, idx) => {
                        const resolved = resolvedReferenceMap.get(`${item.ref_type}:${item.ref_id}`);
                        const fallbackHref = item.ref_type === "note"
                          ? `/notes/${encodeURIComponent(item.ref_id)}`
                          : `/sources/${encodeURIComponent(item.ref_id)}`;
                        return (
                        <li key={`${item.ref_type}:${item.ref_id}`} className="leading-6">
                          <Link to={resolved?.href || fallbackHref} className="font-medium text-primary hover:underline">
                            {item.ref_type === "note" ? "Note" : "Source"} {idx + 1}: {resolved?.title || item.ref_id}
                          </Link>
                          {resolved?.subtitle && <p className="mt-1 text-xs text-muted-foreground">{resolved.subtitle}</p>}
                          {resolved?.excerpt && <p className="mt-1 text-muted-foreground">{resolved.excerpt}</p>}
                        </li>
                        );
                      })}
                    </ol>
                  )}
                </div>

                <div>
                  <h2 className="border-b border-border/60 pb-1 text-2xl font-semibold tracking-tight">Open Questions</h2>
                  <div className="mt-4 text-sm leading-7 text-muted-foreground">
                    {page.open_questions.length ? (
                      <ul className="list-disc space-y-2 pl-5">
                        {page.open_questions.map((question) => <li key={question}>{question}</li>)}
                      </ul>
                    ) : (
                      <p>No open questions recorded.</p>
                    )}
                  </div>
                </div>
              </section>
            </main>

            <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
              <div className="overflow-hidden border border-slate-300/80 bg-background shadow-sm dark:border-border/70">
                <div className="border-b border-slate-300/80 bg-slate-100 px-4 py-3 dark:border-border/70 dark:bg-muted/30">
                  <p className="text-center text-sm font-semibold">Page information</p>
                </div>
                <div className="p-4">
                  <InfoRow label="Type" value={page.page_type} />
                  <InfoRow label="Status" value={role} />
                  <InfoRow label="Origin" value={origin ?? "manual"} />
                  <InfoRow label="Confidence" value={page.confidence_score == null ? "—" : String(page.confidence_score)} />
                  <InfoRow label="References" value={String(referencesCount)} />
                </div>
              </div>

              <div className="border border-border/70 bg-background p-4 shadow-sm">
                <p className="mb-3 text-sm font-semibold">Domains</p>
                <div className="flex flex-wrap gap-2">
                  {page.domains.length ? page.domains.map((domain) => <Badge key={domain} variant="secondary">{domain}</Badge>) : <span className="text-sm text-muted-foreground">—</span>}
                </div>
              </div>

              <div className="border border-border/70 bg-background p-4 shadow-sm">
                <p className="mb-3 text-sm font-semibold">Tags</p>
                <div className="flex flex-wrap gap-2">
                  {page.tags.length ? page.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>) : <span className="text-sm text-muted-foreground">—</span>}
                </div>
              </div>

              <div className="border border-border/70 bg-background p-4 shadow-sm">
                <p className="mb-3 text-sm font-semibold">Provenance</p>
                <div className="space-y-4 text-sm">
                  <InfoRow label="Notes" value={page.derived_from_notes.join(", ")} />
                  <InfoRow label="Sources" value={page.derived_from_sources.join(", ")} />
                </div>
              </div>

            </aside>
          </div>
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Wiki Page?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This deletes the wiki page. Referenced Notes and Sources stay unchanged.</p>
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
