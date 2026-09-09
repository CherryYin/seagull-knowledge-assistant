import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Copy, ExternalLink, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownRenderer } from "@/components/markdown";
import { assetsApi, wikiApi, type ReferenceRead, type WikiArticleDraft, type WikiPage, type WikiPageSourceCreate, type WikiPageUpdate } from "@/lib/api";
import { getWikiOrigin, getWikiRole } from "@/lib/wikiLifecycle";
import { buildAssetHandoffState } from "@/lib/asset-handoff";

const PAGE_TYPES = ["topic", "entity", "concept", "project", "comparison"];

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function joinCsv(value?: string[]) {
  return (value ?? []).join(", ");
}

function draftSectionToQuestion(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildEditorDraftFromUpdateDraft(page: WikiPage, draftItem: WikiArticleDraft) {
  const marker = "## Update Draft Workspace";
  const baseContent = (page.content ?? "").trim();
  const proposalContent = (draftItem.content ?? "").trim();
  const mergedContent = [
    baseContent || `# ${page.title}`,
    marker,
    `> Loaded from update draft #${draftItem.id}. Review and manually merge relevant edits into the canonical wiki content.`,
    "",
    proposalContent,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    ...wikiToDraft(page),
    summary: page.summary ?? draftItem.summary ?? "",
    content: mergedContent,
  };
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
  const [activeUpdateDraftId, setActiveUpdateDraftId] = useState<number | null>(null);
  const [showAppliedUpdateDrafts, setShowAppliedUpdateDrafts] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceForm, setSourceForm] = useState({
    source_id: "",
    relevance_summary: "",
    key_points: "",
    supporting_claims: "",
    cited_chunk_ids: "",
    confidence_score: "",
  });
  const { data: page, isLoading, error } = useQuery({
    queryKey: ["wiki-page", id],
    queryFn: () => wikiApi.get(id!),
    enabled: !!id,
  });

  const { data: assetLineage } = useQuery({
    queryKey: ["asset-knowledge-lineage", "wiki", id],
    queryFn: () => assetsApi.knowledgeLineage("wiki", id!),
    enabled: !!id,
  });

  const { data: sourceEvidence = [] } = useQuery({
    queryKey: ["wiki-page-sources", id],
    queryFn: () => wikiApi.sources(id!),
    enabled: !!id,
  });

  const { data: updateDrafts = [] } = useQuery({
    queryKey: ["wiki-update-drafts", id],
    queryFn: () => wikiApi.updateDrafts(id!),
    enabled: !!id,
  });

  const referenceInputs = useMemo(
    () => sourceEvidence.map((item) => ({ ref_type: "source", ref_id: item.source_id, excerpt: item.relevance_summary })),
    [sourceEvidence]
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
    onSuccess: async () => {
      if (activeUpdateDraftId != null) {
        await wikiApi.updateMiningArticle(activeUpdateDraftId, { status: "applied" });
        queryClient.invalidateQueries({ queryKey: ["wiki-update-drafts", id] });
      }
      queryClient.invalidateQueries({ queryKey: ["wiki-page", id] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      setEditing(false);
      setDraft(null);
      setActiveUpdateDraftId(null);
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

  const sourceMutation = useMutation({
    mutationFn: (payload: WikiPageSourceCreate) => wikiApi.upsertSource(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-page", id] });
      queryClient.invalidateQueries({ queryKey: ["wiki-page-sources", id] });
      setSourceOpen(false);
      setSourceForm({ source_id: "", relevance_summary: "", key_points: "", supporting_claims: "", cited_chunk_ids: "", confidence_score: "" });
    },
  });

  const deleteUpdateDraftMutation = useMutation({
    mutationFn: (articleId: number) => wikiApi.deleteUpdateDraft(articleId),
    onSuccess: (_, articleId) => {
      queryClient.invalidateQueries({ queryKey: ["wiki-update-drafts", id] });
      if (activeUpdateDraftId === articleId) {
        setActiveUpdateDraftId(null);
      }
    },
  });

  const origin = page ? getWikiOrigin(page) : null;
  const role = page ? getWikiRole(page) : "draft";
  const referencesCount = sourceEvidence.length;
  const tocItems = useMemo(() => extractToc(page?.content || ""), [page?.content]);
  const pageClaims = useMemo(() => {
    const claims: Array<{ text: string; status: string; sourceLabel: string }> = [];
    sourceEvidence.forEach((item) => {
      (item.supporting_claims ?? []).forEach((claim) => {
        const text = typeof claim === "string" ? claim : JSON.stringify(claim);
        if (text) claims.push({ text, status: item.cited_chunk_ids?.length ? "supported" : "weak", sourceLabel: item.source_id });
      });
    });
    return claims;
  }, [sourceEvidence]);
  const weakPageClaimCount = pageClaims.filter((claim) => claim.status !== "supported").length;
  const stableReadiness = useMemo(() => {
    if (role !== "stable") {
      if (weakPageClaimCount >= 2) return { level: "warning", message: "Draft still has multiple weak claims. Strengthen evidence before treating it as stable knowledge." };
      return { level: "ok", message: "Draft has no major claim-health warnings." };
    }
    if (weakPageClaimCount >= 2) {
      return { level: "warning", message: "This stable page still has multiple weak claims in attached evidence. Review or recompile before relying on it heavily." };
    }
    if (weakPageClaimCount > 0) {
      return { level: "caution", message: "This stable page has a small number of weak claims. Monitor evidence quality." };
    }
    return { level: "ok", message: "Claim health looks good for stable usage." };
  }, [role, weakPageClaimCount]);

  const sortedUpdateDrafts = useMemo(() => {
    return [...updateDrafts].sort((left, right) => {
      const leftApplied = left.status === "applied" ? 1 : 0;
      const rightApplied = right.status === "applied" ? 1 : 0;
      if (leftApplied !== rightApplied) return leftApplied - rightApplied;
      return right.id - left.id;
    });
  }, [updateDrafts]);

  const pendingUpdateDrafts = sortedUpdateDrafts.filter((item) => item.status !== "applied");
  const appliedUpdateDrafts = sortedUpdateDrafts.filter((item) => item.status === "applied");

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
    setActiveUpdateDraftId(null);
    setEditing(true);
  }

  function applyUpdateDraftToEditor(draftItem: WikiArticleDraft) {
    if (!page) return;
    const base = editing && draft ? draft : buildEditorDraftFromUpdateDraft(page, draftItem);
    const suggestedSection = draftSectionToQuestion(draftItem.metadata_?.suggested_section);
    const nextQuestions = new Set(splitCsv(base.openQuestionsCsv));
    if (suggestedSection) nextQuestions.add(suggestedSection);
    setDraft({
      ...base,
      summary: base.summary || draftItem.summary || "",
      openQuestionsCsv: Array.from(nextQuestions).join(", "),
    });
    setActiveUpdateDraftId(draftItem.id);
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
                onClick={() => navigate("/assets/new", {
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
                onClick={() => navigate("/assets/new", {
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
                onClick={() => navigate("/assets/new", {
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
                onClick={() => navigate("/assets/new", {
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

              {sortedUpdateDrafts.length > 0 && (
                <section className="mb-8 rounded-sm border border-border/70 bg-muted/10 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground">Update Drafts</h2>
                      <p className="mt-1 text-sm text-muted-foreground">Review legacy-triggered Wiki update drafts before copying edits into this canonical page.</p>
                    </div>
                    <Badge variant="secondary">{sortedUpdateDrafts.length}</Badge>
                  </div>
                  <div className="mt-4 space-y-4">
                    {pendingUpdateDrafts.map((draftItem) => (
                      (() => {
                        const suggestedSection = draftSectionToQuestion(draftItem.metadata_?.suggested_section);
                        return (
                      <div key={draftItem.id} className="rounded-sm border border-border/70 bg-background px-4 py-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{draftItem.title}</span>
                          <Badge variant="outline">{String(draftItem.status)}</Badge>
                          {suggestedSection && <Badge variant="secondary">{suggestedSection}</Badge>}
                        </div>
                        {draftItem.summary && <p className="mt-2 text-sm text-muted-foreground">{draftItem.summary}</p>}
                        <div className="mt-3 rounded-sm bg-muted/40 px-3 py-3">
                          <MarkdownRenderer>{draftItem.content}</MarkdownRenderer>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => applyUpdateDraftToEditor(draftItem)}>
                            <Pencil className="h-4 w-4" /> Use In Editor
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteUpdateDraftMutation.mutate(draftItem.id)}
                            disabled={deleteUpdateDraftMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" /> Delete Draft
                          </Button>
                        </div>
                      </div>
                        );
                      })()
                    ))}
                    {appliedUpdateDrafts.length > 0 && (
                      <div className="rounded-sm border border-dashed border-border/70 bg-background/70 px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">Applied Drafts</p>
                            <p className="mt-1 text-xs text-muted-foreground">Already copied into the wiki editor and saved.</p>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => setShowAppliedUpdateDrafts((prev) => !prev)}>
                            {showAppliedUpdateDrafts ? "Hide Applied" : `Show Applied (${appliedUpdateDrafts.length})`}
                          </Button>
                        </div>
                        {showAppliedUpdateDrafts && (
                          <div className="mt-4 space-y-4">
                            {appliedUpdateDrafts.map((draftItem) => {
                              const suggestedSection = draftSectionToQuestion(draftItem.metadata_?.suggested_section);
                              return (
                                <div key={draftItem.id} className="rounded-sm border border-border/70 bg-background px-4 py-4 opacity-80">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium text-foreground">{draftItem.title}</span>
                                    <Badge variant="outline">{String(draftItem.status)}</Badge>
                                    {suggestedSection && <Badge variant="secondary">{suggestedSection}</Badge>}
                                  </div>
                                  {draftItem.summary && <p className="mt-2 text-sm text-muted-foreground">{draftItem.summary}</p>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </section>
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
                  <h2 className="border-b border-border/60 pb-1 text-2xl font-semibold tracking-tight">Claims</h2>
                  {pageClaims.length === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">No explicit claims extracted yet from attached evidence.</p>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {weakPageClaimCount > 0 && (
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          {weakPageClaimCount} claim{weakPageClaimCount > 1 ? "s are" : " is"} weakly supported and may need stronger evidence before this page is treated as stable.
                        </p>
                      )}
                      {pageClaims.slice(0, 8).map((claim, index) => (
                        <div key={`${claim.sourceLabel}-${index}`} className="rounded-md border border-border/70 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{claim.status}</Badge>
                            <span className="text-xs text-muted-foreground">from {claim.sourceLabel}</span>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-foreground">{claim.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h2 className="border-b border-border/60 pb-1 text-2xl font-semibold tracking-tight">References</h2>
                  {referencesCount === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">No references attached yet.</p>
                  ) : (
                    <ol className="mt-4 space-y-4 pl-5 text-sm">
                      {sourceEvidence.map((item, idx) => {
                        const resolved = resolvedReferenceMap.get(`source:${item.source_id}`);
                        return (
                        <li key={item.id} className="leading-6">
                          <Link to={resolved?.href || `/sources/${encodeURIComponent(item.source_id)}`} className="font-medium text-primary hover:underline">
                            Source {idx + 1}: {resolved?.title || item.source_id}
                          </Link>
                          {resolved?.subtitle && <p className="mt-1 text-xs text-muted-foreground">{resolved.subtitle}</p>}
                          <p className="mt-1 text-muted-foreground">{resolved?.excerpt || item.relevance_summary}</p>
                          {renderEvidenceList(item.key_points)}
                          {item.cited_chunk_ids.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Chunks: {item.cited_chunk_ids.join(", ")}</p>}
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
                  <InfoRow label="Claim health" value={weakPageClaimCount > 0 ? `${weakPageClaimCount} weak` : "strong"} />
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

              {(assetLineage?.items.length ?? 0) > 0 && (
                <div className="border border-border/70 bg-background p-4 shadow-sm">
                  <p className="mb-3 text-sm font-semibold">Related Assets</p>
                  <div className="space-y-3">
                    {assetLineage?.items.map((item) => (
                      <div key={`${item.asset_id}:${item.candidate_id ?? item.relation}`} className="rounded-md border border-border/70 p-3">
                        <Link className="text-sm font-medium text-primary hover:underline" to={`/assets/${encodeURIComponent(item.asset_id)}`}>
                          {item.asset_title}
                        </Link>
                        <div className="mt-2 flex flex-wrap gap-1">
                          <Badge variant={item.relation === "distilled" ? "default" : "outline"}>
                            {item.relation === "distilled" ? "Distilled from Asset" : "Referenced by Asset"}
                          </Badge>
                          {item.claim_refs.length > 0 && <Badge variant="secondary">{item.claim_refs.length} Claims</Badge>}
                        </div>
                        {item.contribution_summary && <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.contribution_summary}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="border border-border/70 bg-background p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Evidence tools</p>
                  <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="outline"><Plus className="h-4 w-4" /> Source</Button>
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
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Cited Chunk IDs</label>
                          <Input value={sourceForm.cited_chunk_ids} onChange={(event) => setSourceForm((prev) => ({ ...prev, cited_chunk_ids: event.target.value }))} placeholder="1, 2" className="mt-1" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Confidence</label>
                          <Input value={sourceForm.confidence_score} onChange={(event) => setSourceForm((prev) => ({ ...prev, confidence_score: event.target.value }))} placeholder="0.8" className="mt-1" />
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
