import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { assetsApi, authApi, notesApi, sourcesApi, wikiApi, type Asset, type AssetStatus, type AssetType, type ReadinessCheckResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownRenderer } from "@/components/markdown/MarkdownRenderer";
import { ReferenceChips, type ReferenceItem } from "@/components/ReferenceChips";

type ProductionEvent = {
  event_type?: string;
  asset_id?: string;
  asset_type?: string;
  title?: string;
  status?: string;
  timestamp?: string;
  detail?: Record<string, unknown>;
};

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  ready_to_export: "Ready",
  exported: "Exported",
  published: "Published",
  archived: "Archived",
};

function assetTypeLabel(assetType?: string) {
  if (assetType === "research_brief") return "Research Brief";
  if (assetType === "knowledge_pack") return "Knowledge Pack";
  if (assetType === "newsletter_issue") return "Newsletter Issue";
  if (assetType === "topic_report") return "Topic Report";
  return "Blog Post";
}

function assetTypeDescription(assetType?: string) {
  if (assetType === "research_brief") {
    return "A structured research deliverable focused on findings, risks, recommendations, and evidence-backed references.";
  }
  if (assetType === "knowledge_pack") {
    return "A reusable knowledge bundle focused on curation, reading order, and traceable references.";
  }
  if (assetType === "newsletter_issue") {
    return "A curated issue draft focused on editorial framing, featured items, and sendable structure.";
  }
  if (assetType === "topic_report") {
    return "A systematic topic-level report focused on themes, findings, risks, and recommendations.";
  }
  return "An editable blog draft focused on angle, audience, and readable publish-ready structure.";
}

function assetReaderPresentation(assetType?: AssetType) {
  if (assetType === "research_brief") {
    return {
      layout: "research-brief",
      kicker: "Decision document",
      briefLabel: "Executive brief",
      documentLabel: "Research findings",
      contentsLabel: "Brief sections",
      lineageLabel: "Evidence base",
      headerTone: "from-sky-500/15",
    };
  }
  if (assetType === "knowledge_pack") {
    return {
      layout: "knowledge-pack",
      kicker: "Reusable collection",
      briefLabel: "Pack purpose",
      documentLabel: "Guided knowledge pack",
      contentsLabel: "Reading path",
      lineageLabel: "Included knowledge",
      headerTone: "from-emerald-500/15",
    };
  }
  if (assetType === "newsletter_issue") {
    return {
      layout: "newsletter-issue",
      kicker: "Editorial issue",
      briefLabel: "Issue theme",
      documentLabel: "Curated issue",
      contentsLabel: "Issue lineup",
      lineageLabel: "Editorial sources",
      headerTone: "from-rose-500/15",
    };
  }
  if (assetType === "topic_report") {
    return {
      layout: "topic-report",
      kicker: "Topic synthesis",
      briefLabel: "Report scope",
      documentLabel: "Topic analysis",
      contentsLabel: "Report sections",
      lineageLabel: "Research foundation",
      headerTone: "from-violet-500/15",
    };
  }
  return {
    layout: "blog-post",
    kicker: "Editorial draft",
    briefLabel: "Article promise",
    documentLabel: "Article",
    contentsLabel: "Article map",
    lineageLabel: "Supporting evidence",
    headerTone: "from-amber-500/15",
  };
}

function assetTypeReadinessGuidance(assetType?: string) {
  if (assetType === "research_brief") {
    return "A strong brief usually has at least one grounded wiki angle, attached source evidence, and clear sections for executive summary, findings, risks, and recommendations.";
  }
  if (assetType === "knowledge_pack") {
    return "A strong knowledge pack usually has enough linked material to justify the bundle, a clear 'what’s included' section, a guided reading path, and readable references for later reuse.";
  }
  if (assetType === "newsletter_issue") {
    return "A strong newsletter issue usually has a clear theme, a short editor's note, a focused set of featured items, and readable references behind each highlighted item.";
  }
  if (assetType === "topic_report") {
    return "A strong topic report usually has stable wiki grounding, enough material to support themes and findings, explicit risks or gaps, and recommendations that remain traceable to references.";
  }
  return "A strong blog post usually has a clear angle, enough evidence to support the thesis, and readable references before export.";
}

function assetTypeReadinessTitle(assetType?: string) {
  if (assetType === "research_brief") return "Research Brief Readiness";
  if (assetType === "knowledge_pack") return "Knowledge Pack Readiness";
  if (assetType === "newsletter_issue") return "Newsletter Issue Readiness";
  if (assetType === "topic_report") return "Topic Report Readiness";
  return "Blog Post Readiness";
}

function assetTypeReadinessIntro(assetType?: string) {
  if (assetType === "research_brief") {
    return "Check whether this brief is evidence-backed, decision-ready, and complete enough to export.";
  }
  if (assetType === "knowledge_pack") {
    return "Check whether this pack has enough material, a clear reading path, and reusable references before export.";
  }
  if (assetType === "newsletter_issue") {
    return "Check whether this issue has a clear theme, curated featured items, and enough source grounding to send.";
  }
  if (assetType === "topic_report") {
    return "Check whether this report has enough topic grounding, clear structure, and traceable findings before export.";
  }
  return "Check whether this post has a clear angle, enough support, and readable references before export.";
}

function markdownHeadings(content?: string | null) {
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => line.match(/^(#{1,3})\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ level: match[1].length, title: match[2].replace(/[*_`]/g, "").trim() }))
    .slice(0, 16);
}

function readinessTone(ready: boolean) {
  return ready ? "border-emerald-200 bg-emerald-50/80" : "border-amber-200 bg-amber-50/70";
}

function formatProductionEventType(eventType?: string) {
  return String(eventType || "unknown")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatProductionEventSummary(event: ProductionEvent) {
  const title = event.title || event.asset_type || "asset";
  switch (event.event_type) {
    case "asset_generated":
      return `Generated ${title}`;
    case "asset_ready_to_export":
      return `${title} is ready to export`;
    case "asset_exported": {
      const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
      return channel ? `Exported ${title} to ${channel}` : `Exported ${title}`;
    }
    case "asset_published": {
      const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
      return channel ? `Published ${title} via ${channel}` : `Published ${title}`;
    }
    case "asset_feedback_recorded":
      return `Recorded feedback for ${title}`;
    default:
      return formatProductionEventType(event.event_type);
  }
}

function productionEventMeta(event: ProductionEvent): string[] {
  const parts: string[] = [];
  const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
  const exportFormat = typeof event.detail?.export_format === "string" ? event.detail.export_format : undefined;
  const publishUrl = typeof event.detail?.publish_url === "string" ? event.detail.publish_url : undefined;
  const feedback = typeof event.detail?.feedback === "string" ? event.detail.feedback : undefined;

  if (channel) parts.push(`Channel: ${channel}`);
  if (exportFormat && exportFormat !== channel) parts.push(`Format: ${exportFormat}`);
  if (publishUrl) parts.push(`URL: ${publishUrl}`);
  if (feedback) parts.push(`Feedback: ${feedback}`);

  return parts;
}

function normalizeAssetText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildPrimaryAction(asset: Asset, readiness?: ReadinessCheckResult | null) {
  if (asset.status === "draft") {
    return { label: "Move to Review", nextStatus: "in_review" as AssetStatus, variant: "default" as const };
  }
  if (asset.status === "in_review") {
    return {
      label: readiness?.ready ? "Mark Ready to Export" : "Ready to Export",
      nextStatus: "ready_to_export" as AssetStatus,
      variant: "default" as const,
    };
  }
  if (asset.status === "ready_to_export") {
    return { label: "Export Markdown", nextStatus: null, variant: "default" as const };
  }
  if (asset.status === "exported") {
    return { label: "Mark Published", nextStatus: "published" as AssetStatus, variant: "default" as const };
  }
  return null;
}

function ReadinessList({ title, items, tone, empty }: { title: string; items: string[]; tone: string; empty: string }) {
  return (
    <div className="space-y-2 rounded-md border bg-background/70 p-3">
      <p className="text-sm font-semibold">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className={`space-y-1 text-sm ${tone}`}>
          {items.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AssetDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const backTo = locationState?.backTo || "/assets";
  const backLabel = locationState?.backLabel || "Back to Assets";

  const assetQuery = useQuery({
    queryKey: ["asset", id],
    queryFn: () => assetsApi.get(id),
    enabled: Boolean(id),
  });

  const sourceOptionsQuery = useQuery({
    queryKey: ["asset-detail-sources"],
    queryFn: () => sourcesApi.list({ limit: 100 }),
  });

  const noteOptionsQuery = useQuery({
    queryKey: ["asset-detail-notes"],
    queryFn: () => notesApi.list({ limit: 100 }),
  });

  const asset = assetQuery.data;
  const readerPresentation = assetReaderPresentation(asset?.asset_type);
  const assetQueryError = assetQuery.error instanceof Error ? assetQuery.error.message : null;

  const [publishUrl, setPublishUrl] = useState("");
  const [publishChannel, setPublishChannel] = useState("");
  const [publishFeedback, setPublishFeedback] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBrief, setEditBrief] = useState("");
  const [editOutline, setEditOutline] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [editStyle, setEditStyle] = useState("");

  useEffect(() => {
    const feedback = ((asset?.metadata_ || {}) as Record<string, unknown>).publish_feedback as Record<string, unknown> | undefined;
    setPublishUrl(typeof feedback?.publish_url === "string" ? feedback.publish_url : "");
    setPublishChannel(typeof feedback?.channel === "string" ? feedback.channel : "");
    setPublishFeedback(typeof feedback?.feedback === "string" ? feedback.feedback : "");
  }, [asset]);

  useEffect(() => {
    setEditTitle(asset?.title ?? "");
    setEditBrief(asset?.brief ?? "");
    setEditOutline(asset?.outline ?? "");
    setEditDraft(asset?.draft_content ?? "");
    setEditStyle(asset?.style_notes ?? "");
  }, [asset]);

  const sourceMap = new Map((sourceOptionsQuery.data?.items ?? []).map((item) => [item.id, item]));
  const noteMap = new Map((noteOptionsQuery.data?.items ?? []).map((item) => [item.id, item]));

  const wikiRefsQuery = useQuery({
    queryKey: ["asset-detail-wiki-refs", id, asset?.wiki_refs],
    queryFn: () => wikiApi.resolveReferences((asset?.wiki_refs ?? []).map((wikiId) => ({ ref_type: "wiki", ref_id: wikiId }))),
    enabled: Boolean(asset?.wiki_refs?.length),
  });

  const productionMemoryQuery = useQuery({
    queryKey: ["asset-production-memory", id],
    queryFn: () => authApi.listMyMemories("production_memory"),
  });

  const assetsListQuery = useQuery({
    queryKey: ["assets", "detail-fallback"],
    queryFn: () => assetsApi.list({ limit: 100 }),
    enabled: assetQuery.isError,
  });

  const readinessQuery = useQuery({
    queryKey: ["asset-readiness", id],
    queryFn: () => assetsApi.checkReadiness(id),
    enabled: Boolean(id && asset),
  });

  const refreshAsset = async () => {
    await queryClient.invalidateQueries({ queryKey: ["asset", id] });
    await queryClient.invalidateQueries({ queryKey: ["assets"] });
    await queryClient.invalidateQueries({ queryKey: ["asset-production-memory", id] });
    await queryClient.invalidateQueries({ queryKey: ["asset-readiness", id] });
  };

  const statusMutation = useMutation({
    mutationFn: (status: AssetStatus) => assetsApi.update(id, { status }),
    onSuccess: refreshAsset,
  });

  const editMutation = useMutation({
    mutationFn: () => assetsApi.update(id, {
      title: editTitle.trim(),
      brief: editBrief,
      outline: editOutline,
      draft_content: editDraft,
      style_notes: editStyle,
    }),
    onSuccess: refreshAsset,
  });

  const exportMutation = useMutation({
    mutationFn: () => assetsApi.exportMarkdown(id),
    onSuccess: refreshAsset,
  });

  const publishMutation = useMutation({
    mutationFn: () => assetsApi.updatePublishFeedback(id, {
      publish_url: publishUrl || null,
      channel: publishChannel || null,
      published_at: new Date().toISOString(),
      feedback: publishFeedback || null,
    }),
    onSuccess: refreshAsset,
  });

  const savePublishFeedbackMutation = useMutation({
    mutationFn: () => assetsApi.updatePublishFeedback(id, {
      publish_url: publishUrl || null,
      channel: publishChannel || null,
      feedback: publishFeedback || null,
    }),
    onSuccess: refreshAsset,
  });

  const feedbackToNoteMutation = useMutation({
    mutationFn: () => assetsApi.feedbackToNote(id),
  });

  const actionError = [statusMutation.error, exportMutation.error, publishMutation.error, savePublishFeedbackMutation.error, feedbackToNoteMutation.error]
    .find((error): error is Error => error instanceof Error)?.message ?? null;

  const deleteMutation = useMutation({
    mutationFn: () => assetsApi.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      navigate("/assets");
    },
  });

  const sourceRefItems: ReferenceItem[] = (asset?.source_refs ?? []).map((sourceId) => {
    const source = sourceMap.get(sourceId);
    return {
      ref_type: "source",
      ref_id: sourceId,
      title: source?.title ?? sourceId,
      subtitle: source?.source_type ?? null,
      href: `/sources/${encodeURIComponent(sourceId)}`,
    };
  });

  const noteRefItems: ReferenceItem[] = (asset?.note_refs ?? []).map((noteId) => {
    const note = noteMap.get(noteId);
    return {
      ref_type: "note",
      ref_id: noteId,
      title: note?.title ?? noteId,
      subtitle: note?.note_type ?? null,
      href: `/notes/${encodeURIComponent(noteId)}`,
    };
  });

  const stableWikiItems = (wikiRefsQuery.data?.items ?? []).filter((item) => item.status === "stable") as ReferenceItem[];
  const candidateWikiItems = (wikiRefsQuery.data?.items ?? []).filter((item) => item.status !== "stable") as ReferenceItem[];
  const productionEvents: ProductionEvent[] = ((productionMemoryQuery.data?.[0]?.value as { events?: ProductionEvent[] } | undefined)?.events ?? [])
    .filter((event) => String(event.asset_id || "") === id)
    .slice(0, 12);

  const fallbackTitle = useMemo(() => {
    const titleFromEvent = productionEvents.find((event) => event.title)?.title;
    if (titleFromEvent) return titleFromEvent;
    const decoded = decodeURIComponent(id);
    const match = decoded.match(/^asset-\d{8}-(.+)-[0-9a-f]{8}$/i);
    if (!match) return null;
    return match[1].replace(/-/g, " ");
  }, [id, productionEvents]);

  const fallbackTitleCandidates = useMemo(() => {
    const candidates = new Set<string>();
    if (fallbackTitle) {
      candidates.add(normalizeAssetText(fallbackTitle));
    }
    const decoded = decodeURIComponent(id);
    const match = decoded.match(/^asset-\d{8}-(.+)-[0-9a-f]{8}$/i);
    if (match) {
      const rawSlug = match[1];
      candidates.add(normalizeAssetText(rawSlug));
      candidates.add(normalizeAssetText(rawSlug.replace(/-/g, " ")));
      candidates.add(normalizeAssetText(rawSlug.replace(/-/g, "")));
    }
    return [...candidates].filter(Boolean);
  }, [fallbackTitle, id]);

  const fallbackAsset = useMemo(() => {
    if (!fallbackTitleCandidates.length) return null;
    const items = assetsListQuery.data?.items ?? [];
    const exact = items.find((item) => fallbackTitleCandidates.includes(normalizeAssetText(item.title)));
    if (exact) return exact;
    return items.find((item) => fallbackTitleCandidates.some((candidate) => normalizeAssetText(item.title).includes(candidate) || candidate.includes(normalizeAssetText(item.title)))) ?? null;
  }, [assetsListQuery.data, fallbackTitleCandidates]);

  const isBusy = statusMutation.isPending || exportMutation.isPending || publishMutation.isPending || savePublishFeedbackMutation.isPending;
  const primaryAction = useMemo(() => (asset ? buildPrimaryAction(asset, readinessQuery.data) : null), [asset, readinessQuery.data]);
  const headings = useMemo(() => markdownHeadings(asset?.draft_content), [asset?.draft_content]);
  const audience = typeof asset?.metadata_?.audience === "string" ? asset.metadata_.audience : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={backTo} className="text-sm text-primary hover:underline">{backLabel}</Link>
            {asset && <><span className="text-muted-foreground">/</span><Badge variant="outline">{assetTypeLabel(asset.asset_type)}</Badge><Badge variant="secondary">{STATUS_LABELS[asset.status]}</Badge></>}
            {!asset && <span className="text-sm text-muted-foreground">Loading Asset…</span>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => exportMutation.mutate()} disabled={!asset || isBusy || asset.status !== "ready_to_export"}>
              {exportMutation.isPending ? "Exporting…" : "Export Markdown"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (asset && window.confirm(`Delete asset \"${asset.title}\"? This cannot be undone.`)) {
                  deleteMutation.mutate();
                }
              }}
              disabled={!asset || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>

        {assetQuery.isError && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Asset unavailable</CardTitle>
              <CardDescription>
                {assetQueryError?.startsWith("404:")
                  ? "This asset no longer exists or belongs to another user."
                  : "Failed to load this asset."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button variant="outline" onClick={() => navigate(backTo)}>
                {backLabel}
              </Button>
              {fallbackAsset && (
                <Button onClick={() => navigate(`/assets/${encodeURIComponent(fallbackAsset.id)}`, { state: { backTo, backLabel } })}>
                  Open Current Asset
                </Button>
              )}
              <Button variant="outline" onClick={() => assetQuery.refetch()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {!asset && !assetQuery.isError && <p className="text-sm text-muted-foreground">Loading...</p>}

        {asset && !assetQuery.isError && (
          <Tabs defaultValue="read" className="space-y-6">
            <div className="sticky top-0 z-10 -mx-2 border-b bg-background/95 px-2 py-2 backdrop-blur">
              <TabsList>
                <TabsTrigger value="read">Read</TabsTrigger>
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
                <TabsTrigger value="production">Production</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="read" className="mt-0 space-y-8">
              <article data-reader-layout={readerPresentation.layout} className="overflow-hidden rounded-3xl border bg-card shadow-sm">
                <header className={`border-b bg-gradient-to-br ${readerPresentation.headerTone} via-background to-background px-6 py-10 sm:px-10 lg:px-14`}>
                  <div className="mx-auto max-w-4xl">
                    <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{readerPresentation.kicker}</p>
                    <div className="mb-5 flex flex-wrap items-center gap-2">
                      <Badge>{assetTypeLabel(asset.asset_type)}</Badge>
                      <Badge variant="outline">{STATUS_LABELS[asset.status]}</Badge>
                      <span className="text-xs text-muted-foreground">Updated {new Date(asset.updated_at).toLocaleDateString()}</span>
                    </div>
                    <h2 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{asset.title}</h2>
                    {asset.brief && (
                      <div className="mt-7 max-w-3xl rounded-2xl border bg-background/70 p-5 shadow-sm">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.briefLabel}</p>
                        <p className="mt-2 text-lg leading-8 text-foreground/80">{asset.brief}</p>
                      </div>
                    )}
                    <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                      {audience && <span><span className="font-medium text-foreground">Audience:</span> {audience}</span>}
                      <span><span className="font-medium text-foreground">Evidence:</span> {sourceRefItems.length + noteRefItems.length + stableWikiItems.length + candidateWikiItems.length} records</span>
                    </div>
                  </div>
                </header>

                <div className="mx-auto grid max-w-6xl gap-10 px-6 py-10 sm:px-10 lg:grid-cols-[minmax(0,1fr)_240px] lg:px-14">
                  <div className="min-w-0">
                    <p className="mb-6 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{readerPresentation.documentLabel}</p>
                    {asset.draft_content?.trim() ? (
                      <div className="prose prose-slate max-w-none text-base leading-8 dark:prose-invert prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h2:mt-12 prose-h2:border-b prose-h2:pb-3 prose-p:my-5 prose-li:my-2 prose-blockquote:border-primary/40 prose-blockquote:bg-muted/30 prose-blockquote:px-5 prose-blockquote:py-1">
                        <MarkdownRenderer>{asset.draft_content}</MarkdownRenderer>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">This Asset does not have draft content yet. Continue it from the production workspace.</div>
                    )}
                  </div>

                  <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
                    <div className="rounded-2xl border bg-muted/20 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.contentsLabel}</p>
                      {headings.length > 0 ? (
                        <ol className="mt-3 space-y-2 text-sm">
                          {headings.map((heading, index) => <li key={`${heading.title}-${index}`} className={heading.level === 1 ? "font-medium" : heading.level === 2 ? "pl-2" : "pl-5 text-muted-foreground"}>{heading.title}</li>)}
                        </ol>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">No navigable sections yet.</p>
                      )}
                    </div>
                    <div className="rounded-2xl border p-4">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.lineageLabel}</p>
                      <div className="mt-3 space-y-3 text-sm">
                        <div className="flex justify-between"><span>Sources</span><span className="font-medium">{sourceRefItems.length}</span></div>
                        <div className="flex justify-between"><span>Notes</span><span className="font-medium">{noteRefItems.length}</span></div>
                        <div className="flex justify-between"><span>Wiki</span><span className="font-medium">{stableWikiItems.length + candidateWikiItems.length}</span></div>
                      </div>
                    </div>
                  </aside>
                </div>
              </article>
            </TabsContent>

            <TabsContent value="edit" className="mt-0">
              <Card>
                <CardHeader><CardTitle>Edit Asset</CardTitle><CardDescription>Update the working document, then return to Read to review the rendered result.</CardDescription></CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-title">Title</label><Input id="asset-edit-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></div>
                    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-style">Style guidance</label><Input id="asset-edit-style" value={editStyle} onChange={(event) => setEditStyle(event.target.value)} /></div>
                  </div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-brief">Brief</label><Textarea id="asset-edit-brief" rows={4} value={editBrief} onChange={(event) => setEditBrief(event.target.value)} /></div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-outline">Outline</label><Textarea id="asset-edit-outline" className="font-mono text-sm" rows={8} value={editOutline} onChange={(event) => setEditOutline(event.target.value)} /></div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-draft">Draft Markdown</label><Textarea id="asset-edit-draft" className="min-h-[520px] font-mono text-sm leading-6" value={editDraft} onChange={(event) => setEditDraft(event.target.value)} /></div>
                  <div className="flex items-center gap-3"><Button onClick={() => editMutation.mutate()} disabled={!editTitle.trim() || editMutation.isPending}>{editMutation.isPending ? "Saving…" : "Save Changes"}</Button>{editMutation.isSuccess && <span className="text-sm text-emerald-700">Saved. Open Read to inspect the rendered document.</span>}{editMutation.isError && <span className="text-sm text-destructive">Could not save Asset changes.</span>}</div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="evidence" className="mt-0">
              <Card>
                <CardHeader><CardTitle>Knowledge Evidence</CardTitle><CardDescription>Sources, Notes, and Wiki pages used to produce this Asset.</CardDescription></CardHeader>
                <CardContent className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-2"><h3 className="text-sm font-semibold">Sources</h3><ReferenceChips items={sourceRefItems} />{sourceRefItems.length === 0 && <p className="text-sm text-muted-foreground">No Source references attached.</p>}</div>
                  <div className="space-y-2"><h3 className="text-sm font-semibold">Notes</h3><ReferenceChips items={noteRefItems} />{noteRefItems.length === 0 && <p className="text-sm text-muted-foreground">No Note references attached.</p>}</div>
                  <div className="space-y-2"><h3 className="text-sm font-semibold">Stable Wiki</h3><ReferenceChips items={stableWikiItems} />{stableWikiItems.length === 0 && <p className="text-sm text-muted-foreground">No stable Wiki references attached.</p>}</div>
                  <div className="space-y-2"><h3 className="text-sm font-semibold">Draft Wiki</h3><ReferenceChips items={candidateWikiItems} />{candidateWikiItems.length === 0 && <p className="text-sm text-muted-foreground">No draft Wiki references attached.</p>}</div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="production" className="mt-0 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Production Actions</CardTitle>
                <CardDescription>Push this asset from draft into review, export-ready, exported, and published states.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {primaryAction?.nextStatus && (
                    <Button onClick={() => statusMutation.mutate(primaryAction.nextStatus)} disabled={isBusy || (primaryAction.nextStatus === "ready_to_export" && !readinessQuery.data?.ready)}>
                      {statusMutation.isPending ? "Updating…" : primaryAction.label}
                    </Button>
                  )}
                  {primaryAction && !primaryAction.nextStatus && asset.status === "ready_to_export" && (
                    <Button onClick={() => exportMutation.mutate()} disabled={isBusy}>
                      {exportMutation.isPending ? "Exporting…" : primaryAction.label}
                    </Button>
                  )}
                  {asset.status !== "draft" && asset.status !== "archived" && asset.status !== "published" && (
                    <Button variant="outline" onClick={() => statusMutation.mutate("draft")} disabled={isBusy}>
                      Move back to Draft
                    </Button>
                  )}
                  {asset.status === "published" && (
                    <Button variant="outline" onClick={() => statusMutation.mutate("archived")} disabled={isBusy}>
                      Archive
                    </Button>
                  )}
                </div>

                {statusMutation.isError && (
                  <p className="text-sm text-destructive">Failed to update asset status. Check readiness and retry.</p>
                )}
                {exportMutation.isError && (
                  <p className="text-sm text-destructive">Export failed. Make sure the asset is ready and has references.</p>
                )}
                {publishMutation.isError && (
                  <p className="text-sm text-destructive">Failed to mark asset as published. Add publish details and retry.</p>
                )}
                {actionError?.startsWith("404:") && (
                  <p className="text-sm text-destructive">This asset no longer exists. Go back to the assets list and reopen the current item.</p>
                )}

                {readinessQuery.data && (
                  <div className={`space-y-4 rounded-lg border p-4 ${readinessTone(readinessQuery.data.ready)}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{assetTypeReadinessTitle(asset.asset_type)}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{assetTypeReadinessIntro(asset.asset_type)}</p>
                      </div>
                      <Badge variant={readinessQuery.data.ready ? "default" : "secondary"}>
                        {readinessQuery.data.ready ? "Ready to export" : "Needs work"}
                      </Badge>
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <ReadinessList title="Blocking" items={readinessQuery.data.blocking_reasons} tone="text-destructive" empty="No blocking issues." />
                      <ReadinessList title="Warnings" items={readinessQuery.data.warning_reasons} tone="text-amber-700" empty="No warning signals." />
                      <ReadinessList title="Suggested next steps" items={readinessQuery.data.suggestion_reasons} tone="text-sky-700" empty="No extra suggestions right now." />
                    </div>

                    <div className="rounded-md border bg-background/80 p-3 text-sm text-muted-foreground">
                      {assetTypeReadinessGuidance(asset.asset_type)}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Publish Details</CardTitle>
                <CardDescription>Save publish metadata now, or mark the asset as published once it ships.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Publish URL</h3>
                    <Input value={publishUrl} onChange={(e) => setPublishUrl(e.target.value)} placeholder="https://..." />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Channel</h3>
                    <Input value={publishChannel} onChange={(e) => setPublishChannel(e.target.value)} placeholder="blog, x, newsletter" />
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Publish Feedback</h3>
                  <Textarea value={publishFeedback} onChange={(e) => setPublishFeedback(e.target.value)} rows={4} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => savePublishFeedbackMutation.mutate()} disabled={isBusy || (!publishUrl.trim() && !publishChannel.trim() && !publishFeedback.trim())}>
                    {savePublishFeedbackMutation.isPending ? "Saving…" : "Save Publish Details"}
                  </Button>
                  <Button onClick={() => publishMutation.mutate()} disabled={isBusy || asset.status !== "exported"}>
                    {publishMutation.isPending ? "Publishing…" : "Mark Published"}
                  </Button>
                  <Button variant="outline" onClick={() => feedbackToNoteMutation.mutate()} disabled={feedbackToNoteMutation.isPending || !publishFeedback.trim()}>
                    {feedbackToNoteMutation.isPending ? "Converting…" : "Feedback to Note"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Production Timeline</CardTitle>
                <CardDescription>Asset creation, export, publication, and feedback events recorded in Production History.</CardDescription>
              </CardHeader>
              <CardContent>
                {productionEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No production events recorded yet.</p>
                ) : (
                  <div className="space-y-3">
                    {productionEvents.map((event, index) => (
                      <div key={`${String(event.timestamp || index)}-${String(event.event_type || index)}`} className="rounded-md border bg-muted/20 p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">{formatProductionEventType(event.event_type)}</Badge>
                              {event.asset_type && <Badge variant="secondary">{event.asset_type}</Badge>}
                              {event.status && <Badge variant="secondary">{event.status}</Badge>}
                            </div>
                            <div className="text-sm font-medium">{formatProductionEventSummary(event)}</div>
                            {(event.title || event.asset_id) && (
                              <p className="text-xs text-muted-foreground">
                                {event.title || "Untitled asset"}
                                {event.asset_id ? ` · ${event.asset_id}` : ""}
                              </p>
                            )}
                            {productionEventMeta(event).length > 0 && (
                              <div className="flex flex-wrap gap-2 pt-1">
                                {productionEventMeta(event).map((item) => (
                                  <span key={item} className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                                    {item}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {event.timestamp ? new Date(event.timestamp).toLocaleString() : "Unknown time"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
