import { useLocation, useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useRef, useEffect } from "react";
import { ArrowLeft, Download, ExternalLink, Trash2, List, FileText, Pencil, Check, X, Rss, RefreshCw, Bot, StickyNote, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CategorySelect } from "@/components/CategorySelect";
import { MarkdownRenderer } from "@/components/markdown";
import { sourcesApi, notesApi, wikiApi, categoriesApi, downloadFile, type Source, type SourceChunk, type SourceUpdate, type SourceList } from "@/lib/api";
import { buildAssetHandoffState } from "@/lib/asset-handoff";
import { getSourceProcessingState, getSourceProcessingSteps } from "@/lib/sourceProcessingStatus";

type ViewMode = "full" | "slices";
type SourceEditDraft = {
  title: string;
  category_id: number;
  source_type: string;
  url: string;
  metadata?: Record<string, unknown> | null;
};

export function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const backTo = locationState?.backTo || "/sources";
  const backLabel = locationState?.backLabel || "Back to Sources";
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("full");
  const [selectedChunk, setSelectedChunk] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SourceEditDraft | null>(null);

  const { data: source, isLoading, error } = useQuery({
    queryKey: ["source", id],
    queryFn: () => sourcesApi.get(id!),
    enabled: !!id,
  });

  const { data: chunks } = useQuery({
    queryKey: ["source-chunks", id],
    queryFn: () => sourcesApi.chunks(id!),
    enabled: !!id && viewMode === "slices",
  });

  const { data: catData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const categories = catData?.items ?? [];

  const updateMutation = useMutation({
    mutationFn: (body: SourceUpdate) => sourcesApi.update(id!, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(["source", id], updated);
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => sourcesApi.delete(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      navigate(backTo);
    },
  });

  const retryExtractionMutation = useMutation({
    mutationFn: () => sourcesApi.retryExtraction(id!),
    onSuccess: (updated) => {
      queryClient.setQueryData(["source", id], updated);
      queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });

  const downloadPdfMutation = useMutation({
    mutationFn: () => sourcesApi.downloadPdf(id!),
    onSuccess: (pdfSource) => {
      queryClient.invalidateQueries({ queryKey: ["source", id] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      navigate(`/sources/${encodeURIComponent(pdfSource.id)}`, {
        state: { backTo: `/sources/${encodeURIComponent(source?.id || id!)}`, backLabel: "Back to Article Source" },
      });
    },
  });

  const isRssEnabled = source?.metadata_?.rss_enabled === "true";
  const isWebDirectoryEnabled = source?.metadata_?.web_directory_enabled === true;
  const pdfUrl = typeof source?.metadata_?.pdf_url === "string"
    ? source.metadata_.pdf_url
    : typeof source?.metadata_?.download_url === "string"
      ? source.metadata_.download_url
      : null;
  const downloadedPdfSourceId = typeof source?.metadata_?.downloaded_pdf_source_id === "string"
    ? source.metadata_.downloaded_pdf_source_id
    : null;
  const extractionMode = typeof source?.metadata_?.extraction_mode === "string"
    ? source.metadata_.extraction_mode
    : null;
  const extractionStatus = typeof source?.metadata_?.extraction_status === "string"
    ? source.metadata_.extraction_status
    : null;
  const isNews = source?.source_type === "article" && source?.metadata_?.kind === "news";
  const newsSourceName = typeof source?.metadata_?.source_name === "string" ? source.metadata_.source_name : null;
  const newsAuthor = typeof source?.metadata_?.author === "string" ? source.metadata_.author : null;
  const newsPublishedAt = typeof source?.metadata_?.published_at === "string" ? source.metadata_.published_at : null;

  const { data: articlesData } = useQuery({
    queryKey: ["source-articles", id],
    queryFn: () => sourcesApi.listArticles(id!, { limit: 10 }),
    enabled: !!id && source?.source_type === "web" && (isRssEnabled || isWebDirectoryEnabled),
  });

  const enableRssMutation = useMutation({
    mutationFn: () => sourcesApi.enableRss(id!),
    onSuccess: (updated) => {
      queryClient.setQueryData(["source", id], updated);
      queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });

  const disableRssMutation = useMutation({
    mutationFn: () => sourcesApi.disableRss(id!),
    onSuccess: (updated) => {
      queryClient.setQueryData(["source", id], updated);
      queryClient.invalidateQueries({ queryKey: ["source-articles", id] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });

  const [fetchResult, setFetchResult] = useState<{ new_articles: number } | null>(null);
  const [webDiscoverResult, setWebDiscoverResult] = useState<{ discovered: number; imported: number; updated: number; skipped: number } | null>(null);
  const [createdNoteId, setCreatedNoteId] = useState<string | null>(null);
  const [queuedRefreshCount, setQueuedRefreshCount] = useState<number | null>(null);

  const fetchFeedMutation = useMutation({
    mutationFn: () => sourcesApi.fetchFeed(id!),
    onSuccess: (result) => {
      setFetchResult(result);
      queryClient.invalidateQueries({ queryKey: ["source-articles", id] });
    },
  });

  const discoverWebArticlesMutation = useMutation({
    mutationFn: () => sourcesApi.discoverWebArticles(id!, { limit: 50 }),
    onSuccess: (result) => {
      setWebDiscoverResult(result);
      queryClient.invalidateQueries({ queryKey: ["source", id] });
      queryClient.invalidateQueries({ queryKey: ["source-articles", id] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });

  const createNoteMutation = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("Source is not loaded");
      const selectedContent = viewMode === "slices" && chunks?.[selectedChunk]?.content
        ? chunks[selectedChunk].content
        : source.raw_content || "";
      return notesApi.create({
        title: source.title,
        category_id: source.category_id,
        note_type: "inbox",
        status: "seed",
        confidence: "medium",
        tags: ["from-source"],
        abstract: source.raw_content ? source.raw_content.slice(0, 240) : undefined,
        content: selectedContent || `# ${source.title}\n\n`,
        source_ids: [source.id],
      });
    },
    onSuccess: (note) => {
      setCreatedNoteId(note.id);
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });

  const queueWikiRefreshMutation = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("Source is not loaded");
      return wikiApi.suggest({ trigger_type: "source", trigger_id: source.id, limit: 5 });
    },
    onSuccess: (suggestions) => {
      setQueuedRefreshCount(suggestions.length);
      queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
  });

  function askAgentAboutSource() {
    if (!source) return;
    const chunk = viewMode === "slices" ? chunks?.[selectedChunk] : null;
    navigate("/chat", {
      state: {
        objectRef: {
          object_type: "source",
          object_id: source.id,
          title: source.title,
          url: source.url ?? null,
        },
        workflowId: "summarize-source",
        promptSeed: chunk
          ? `Use source "${source.title}" (${source.id}) and this selected chunk to help me:\n\n${chunk.content.slice(0, 2000)}`
          : `Use source "${source.title}" (${source.id}) to help me summarize, analyze, or turn it into a summary draft, note, memory, or wiki candidate.`,
      },
    });
  }

  function startEdit() {
    if (!source) return;
    const metadata = source.metadata_ ?? {};
    setDraft({
      title: source.title,
      category_id: source.category_id,
      source_type: source.source_type,
      url: source.url ?? "",
      metadata: {
        ...metadata,
        auto_discover: metadata.auto_discover === true,
        discover_interval_hours: Number(metadata.discover_interval_hours ?? 24),
        max_articles_per_run: Number(metadata.max_articles_per_run ?? 50),
        auto_refresh: metadata.auto_refresh === true,
        refresh_interval_days: Number(metadata.refresh_interval_days ?? 7),
      },
    });
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
  }

  function saveEdit() {
    if (!draft || !source) return;
    const patch: SourceUpdate = {};
    if (draft.title !== source.title) patch.title = draft.title;
    if (draft.category_id !== source.category_id) patch.category_id = draft.category_id;
    if (draft.source_type !== source.source_type) patch.source_type = draft.source_type;
    if ((draft.url || null) !== (source.url || null)) patch.url = draft.url || null;
    if (JSON.stringify(draft.metadata ?? null) !== JSON.stringify(source.metadata_ ?? null)) patch.metadata = draft.metadata ?? null;
    updateMutation.mutate(patch);
  }

  // Find the selected chunk's content position in raw_content for highlighting
  const highlightRange = useMemo(() => {
    if (!chunks || !source?.raw_content) return null;
    const chunk = chunks[selectedChunk];
    if (!chunk) return null;
    const idx = source.raw_content.indexOf(chunk.content);
    if (idx === -1) return null;
    return { start: idx, end: idx + chunk.content.length };
  }, [chunks, selectedChunk, source?.raw_content]);

  // Scroll the highlighted text into view in the preview panel
  useEffect(() => {
    if (!previewRef.current) return;
    const mark = previewRef.current.querySelector("[data-highlight]");
    if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightRange]);

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading...</div>;
  if (error || !source) {
    return (
      <div className="p-8 space-y-3">
        <p className="text-destructive">Source not found.</p>
        <p className="text-sm text-muted-foreground">
          This source may have been deleted, or the list may still contain stale cached data.
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate(backTo)}>
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Button>
      </div>
    );
  }

  const hasChunks = chunks && chunks.length > 0;
  const processing = getSourceProcessingState(source, { chunkCount: chunks?.length ?? null });
  const processingSteps = getSourceProcessingSteps(source, { chunkCount: chunks?.length ?? null });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          {!editing && (
            <Button variant="outline" size="sm" onClick={startEdit}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          )}
          {editing && (
            <>
              <Button variant="default" size="sm" onClick={saveEdit} disabled={updateMutation.isPending}>
                <Check className="h-4 w-4" /> {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={updateMutation.isPending}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          <div className="ml-auto flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              onClick={() => setViewMode("full")}
              className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${viewMode === "full" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
            >
              <FileText className="h-3.5 w-3.5 inline-block mr-1" />Full
            </button>
            <button
              onClick={() => setViewMode("slices")}
              className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${viewMode === "slices" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
            >
              <List className="h-3.5 w-3.5 inline-block mr-1" />Slices
            </button>
          </div>
        </div>

        {/* Source meta */}
        <div className="mb-6">
          {editing && draft ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Title</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div className="flex gap-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Category</label>
                  <div className="mt-1">
                    <CategorySelect
                      categories={categories}
                      value={draft.category_id}
                      onChange={(id) => setDraft({ ...draft, category_id: id })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Type</label>
                  <select
                    className="flex h-9 mt-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-40"
                    value={draft.source_type}
                    onChange={(e) => setDraft({ ...draft, source_type: e.target.value })}
                  >
                    {["pdf", "article", "conversation", "video", "web", "code"].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">URL</label>
                <Input
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  className="mt-1"
                  placeholder="https://..."
                />
              </div>
              {draft.source_type === "web" && (
                <div className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-2">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Web directory auto discover</label>
                        <p className="text-xs text-muted-foreground">Only opt-in directory sources should enable this.</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={draft.metadata?.auto_discover === true}
                        onChange={(e) => setDraft({
                          ...draft,
                          metadata: { ...(draft.metadata ?? {}), auto_discover: e.target.checked },
                        })}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Discover interval hours</label>
                      <Input
                        type="number"
                        min={1}
                        value={String(draft.metadata?.discover_interval_hours ?? 24)}
                        onChange={(e) => setDraft({
                          ...draft,
                          metadata: { ...(draft.metadata ?? {}), discover_interval_hours: Number(e.target.value || 24) },
                        })}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Max articles per run</label>
                      <Input
                        type="number"
                        min={1}
                        value={String(draft.metadata?.max_articles_per_run ?? 50)}
                        onChange={(e) => setDraft({
                          ...draft,
                          metadata: { ...(draft.metadata ?? {}), max_articles_per_run: Number(e.target.value || 50) },
                        })}
                        className="mt-1"
                      />
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Web page auto refresh</label>
                        <p className="text-xs text-muted-foreground">Refreshes normal web pages on a conservative interval.</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={draft.metadata?.auto_refresh === true}
                        onChange={(e) => setDraft({
                          ...draft,
                          metadata: { ...(draft.metadata ?? {}), auto_refresh: e.target.checked },
                        })}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Refresh interval days</label>
                      <Input
                        type="number"
                        min={1}
                        value={String(draft.metadata?.refresh_interval_days ?? 7)}
                        onChange={(e) => setDraft({
                          ...draft,
                          metadata: { ...(draft.metadata ?? {}), refresh_interval_days: Number(e.target.value || 7) },
                        })}
                        className="mt-1"
                      />
                    </div>
                  </div>
                </div>
              )}
              {updateMutation.isError && (
                <p className="text-sm text-destructive">
                  {updateMutation.error instanceof Error ? updateMutation.error.message : "Update failed"}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="source">{source.source_type}</Badge>
                {isNews && <Badge variant="secondary">news</Badge>}
                <Badge variant="outline">{processing.label}</Badge>
                {source.category_name && source.category_name !== "general" && (
                  <Badge variant="secondary">{source.category_name}</Badge>
                )}
              </div>
              <h1 className="text-2xl font-bold">{source.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                External evidence with provenance. Use this as raw material, then create notes, memory, or wiki knowledge from it.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Processing status: {processing.detail}
              </p>
              {(extractionMode || extractionStatus) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Extraction: {extractionMode || "unknown"} · {extractionStatus || "unknown"}
                </p>
              )}
              {source.url && (
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1">
                  {source.url} <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {isNews && (newsSourceName || newsAuthor || newsPublishedAt) && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {newsSourceName && <Badge variant="outline">{newsSourceName}</Badge>}
                  {newsAuthor && <Badge variant="outline">{newsAuthor}</Badge>}
                  {newsPublishedAt && <Badge variant="outline">{new Date(newsPublishedAt).toLocaleString()}</Badge>}
                </div>
              )}
            </>
          )}
          {source.file_path && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadFile(`/sources/${encodeURIComponent(source.id)}/file`, source.title)}
              >
                <Download className="h-4 w-4" /> Download Source File
              </Button>
            </div>
          )}
          {!source.file_path && source.source_type === "article" && downloadedPdfSourceId && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/sources/${encodeURIComponent(downloadedPdfSourceId)}`, {
                  state: { backTo: `/sources/${encodeURIComponent(source.id)}`, backLabel: "Back to Article Source" },
                })}
              >
                <FileText className="h-4 w-4" /> Open Imported PDF
              </Button>
            </div>
          )}
          {!source.file_path && source.source_type === "article" && pdfUrl && !downloadedPdfSourceId && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadPdfMutation.mutate()}
                disabled={downloadPdfMutation.isPending}
              >
                <Download className="h-4 w-4" /> {downloadPdfMutation.isPending ? "Downloading PDF…" : "Download PDF to Library"}
              </Button>
            </div>
          )}
          {source.file_path && extractionStatus !== "completed" && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => retryExtractionMutation.mutate()}
                disabled={retryExtractionMutation.isPending}
              >
                <RefreshCw className={`h-4 w-4 ${retryExtractionMutation.isPending ? "animate-spin" : ""}`} />
                {retryExtractionMutation.isPending ? "Retrying Extraction…" : "Retry Extraction"}
              </Button>
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-2 space-x-4">
            <span>Ingested: {new Date(source.ingested_at).toLocaleString()}</span>
            <span className="font-mono">{source.id}</span>
          </div>
        </div>

        {!editing && (
          <div className="mb-6 rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium">Processing Timeline</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Track whether this source has readable content, chunks, summaries, and review status.
                </p>
              </div>
              <Badge variant="outline">{processing.label}</Badge>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-5">
              {processingSteps.map((step) => (
                <div key={step.key} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{step.label}</p>
                    <Badge
                      variant={step.state === "done" ? "secondary" : "outline"}
                    >
                      {step.state}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
                </div>
              ))}
              {(extractionMode || extractionStatus) && (
                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Extraction</p>
                    <Badge variant={extractionStatus === "completed" ? "secondary" : "outline"}>
                      {extractionStatus || "unknown"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Mode: {extractionMode || "unknown"}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {!editing && (
          <div className="mb-6 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-medium">Actions</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Turn this external evidence into your own note, or ask the agent to work with it.
                </p>
                {createdNoteId && (
                  <button
                    type="button"
                    onClick={() => navigate(`/notes/${encodeURIComponent(createdNoteId)}`, { state: { backTo: `/sources/${encodeURIComponent(source.id)}`, backLabel: "Back to Source" } })}
                    className="mt-2 text-xs text-primary hover:underline"
                  >
                    Created your note from this source. View note.
                  </button>
                )}
                {createNoteMutation.isError && (
                  <p className="mt-2 text-xs text-destructive">
                    {createNoteMutation.error instanceof Error ? createNoteMutation.error.message : "Failed to create note"}
                  </p>
                )}
                {queuedRefreshCount !== null && (
                  <button
                    type="button"
                    onClick={() => navigate("/review/wiki-suggestions")}
                    className="mt-2 block text-xs text-primary hover:underline"
                  >
                    {queuedRefreshCount > 0
                      ? `Wiki refresh queued for ${queuedRefreshCount} page${queuedRefreshCount === 1 ? "" : "s"}. View queue.`
                      : "No matching wiki pages found yet."}
                  </button>
                )}
                {queueWikiRefreshMutation.isError && (
                  <p className="mt-2 text-xs text-destructive">
                    {queueWikiRefreshMutation.error instanceof Error ? queueWikiRefreshMutation.error.message : "Failed to queue wiki refresh"}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => createNoteMutation.mutate()} disabled={createNoteMutation.isPending}>
                  <StickyNote className="h-4 w-4" /> {createNoteMutation.isPending ? "Creating…" : "Create Note From Source"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => queueWikiRefreshMutation.mutate()} disabled={queueWikiRefreshMutation.isPending}>
                  <RefreshCw className={`h-4 w-4 ${queueWikiRefreshMutation.isPending ? "animate-spin" : ""}`} /> Queue Wiki Refresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => source && navigate("/assets", {
                    state: {
                      assetHandoff: buildAssetHandoffState({
                        title: source.title,
                        brief: `Create a blog asset from source: ${source.title}`,
                        source_refs: [source.id],
                      }),
                    },
                  })}
                >
                  <FileText className="h-4 w-4" /> Create Asset
                </Button>
                <Button size="sm" variant="outline" onClick={askAgentAboutSource}>
                  <Bot className="h-4 w-4" /> Ask Agent
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* RSS Section — only for web sources */}
        {source.source_type === "web" && (
          <div className="mb-6 rounded-lg border border-border p-4">
            <div className="flex items-center gap-2 mb-3">
              <Rss className="h-4 w-4 text-orange-500" />
              <span className="text-sm font-medium">RSS Feed</span>
            </div>
            {!isRssEnabled ? (
              <div>
                <p className="text-sm text-muted-foreground mb-2">
                  Enable RSS to automatically fetch new articles from this feed.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => enableRssMutation.mutate()}
                  disabled={enableRssMutation.isPending}
                >
                  <Rss className="h-4 w-4" />
                  {enableRssMutation.isPending ? "Validating feed..." : "Enable RSS"}
                </Button>
                {enableRssMutation.isError && (
                  <p className="text-sm text-destructive mt-2">
                    {enableRssMutation.error instanceof Error ? enableRssMutation.error.message : "Failed to enable RSS"}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300">
                    RSS Active
                  </Badge>
                  {source.metadata_?.feed_title ? (
                    <span className="text-xs text-muted-foreground">{String(source.metadata_.feed_title)}</span>
                  ) : null}
                  {source.metadata_?.last_fetch_at ? (
                    <span className="text-xs text-muted-foreground">
                      Last fetch: {new Date(String(source.metadata_.last_fetch_at)).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setFetchResult(null); fetchFeedMutation.mutate(); }}
                    disabled={fetchFeedMutation.isPending}
                  >
                    <RefreshCw className={`h-4 w-4 ${fetchFeedMutation.isPending ? "animate-spin" : ""}`} />
                    {fetchFeedMutation.isPending ? "Fetching..." : "Fetch Now"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => disableRssMutation.mutate()}
                    disabled={disableRssMutation.isPending}
                  >
                    {disableRssMutation.isPending ? "Disabling..." : "Disable RSS"}
                  </Button>
                </div>
                {fetchResult && (
                  <p className="text-sm text-muted-foreground">
                    Fetched {fetchResult.new_articles} new article{fetchResult.new_articles !== 1 ? "s" : ""}.
                  </p>
                )}
                {fetchFeedMutation.isError && (
                  <p className="text-sm text-destructive">
                    {fetchFeedMutation.error instanceof Error ? fetchFeedMutation.error.message : "Fetch failed"}
                  </p>
                )}
                {articlesData && articlesData.items.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      Recent Articles ({articlesData.total} total)
                    </p>
                    <div className="space-y-1">
                      {articlesData.items.map((article) => (
                        <div
                          key={article.id}
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/50 rounded px-2 py-1 transition-colors"
                          onClick={() => navigate(`/sources/${encodeURIComponent(article.id)}`, { state: { backTo: `/sources/${encodeURIComponent(source.id)}`, backLabel: "Back to Feed Source" } })}
                        >
                          <span className="truncate flex-1">{article.title}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {new Date(article.ingested_at).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {source.source_type === "web" && source.url && !isRssEnabled && (
          <div className="mb-6 rounded-lg border border-border p-4">
            <div className="flex items-center gap-2 mb-3">
              <List className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-medium">Web Directory</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Discover same-site article links under this URL, then import each article as a child web source.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setWebDiscoverResult(null); discoverWebArticlesMutation.mutate(); }}
              disabled={discoverWebArticlesMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 ${discoverWebArticlesMutation.isPending ? "animate-spin" : ""}`} />
              {discoverWebArticlesMutation.isPending ? "Discovering..." : "Discover Articles"}
            </Button>
            {webDiscoverResult && (
              <p className="text-sm text-muted-foreground mt-2">
                Discovered {webDiscoverResult.discovered}, imported {webDiscoverResult.imported}, updated {webDiscoverResult.updated}, skipped {webDiscoverResult.skipped}.
              </p>
            )}
            {discoverWebArticlesMutation.isError && (
              <p className="text-sm text-destructive mt-2">
                {discoverWebArticlesMutation.error instanceof Error ? discoverWebArticlesMutation.error.message : "Discovery failed"}
              </p>
            )}
            {articlesData && articlesData.items.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">Discovered Articles ({articlesData.total} total)</p>
                <div className="space-y-1">
                  {articlesData.items.map((article) => (
                    <div
                      key={article.id}
                      className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/50 rounded px-2 py-1 transition-colors"
                      onClick={() => navigate(`/sources/${encodeURIComponent(article.id)}`, { state: { backTo: `/sources/${encodeURIComponent(source.id)}`, backLabel: "Back to Directory Source" } })}
                    >
                      <span className="truncate flex-1">{article.title}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{new Date(article.ingested_at).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Content area */}
        {viewMode === "full" ? (
          <div className="rounded-lg border border-border p-6 max-h-[70vh] overflow-y-auto">
            <div className="prose">
              <MarkdownRenderer>{source.raw_content || (source.file_path ? "*(Original file stored in MinIO)*" : "*No content*")}</MarkdownRenderer>
            </div>
          </div>
        ) : (
          <div className="flex gap-4" style={{ height: "calc(100vh - 320px)" }}>
            {/* Left: Chunk list */}
            <div className="w-56 shrink-0 rounded-lg border border-border overflow-y-auto">
              <div className="p-2 border-b border-border bg-muted/30">
                <span className="text-xs font-medium text-muted-foreground">
                  {hasChunks ? `${chunks.length} slices` : "No slices"}
                </span>
              </div>
              {hasChunks && chunks.map((chunk, idx) => (
                <button
                  key={chunk.id}
                  onClick={() => setSelectedChunk(idx)}
                  className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors cursor-pointer ${
                    selectedChunk === idx
                      ? "bg-primary/10 border-l-2 border-l-primary"
                      : "hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium ${selectedChunk === idx ? "text-primary" : "text-foreground"}`}>
                      #{idx + 1}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {chunk.content.length} chars
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                    {chunk.content.slice(0, 80)}
                  </p>
                </button>
              ))}
              {!hasChunks && (
                <div className="p-4 text-xs text-muted-foreground text-center">
                  Content too short to chunk, or no chunks generated.
                </div>
              )}
            </div>

            {/* Center: Slice detail */}
            <div className="flex-1 min-w-0 rounded-lg border border-border overflow-y-auto">
              <div className="p-2 border-b border-border bg-muted/30 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Slice Details</span>
                {hasChunks && (
                  <span className="text-[10px] text-muted-foreground">
                    #{selectedChunk + 1} / {chunks.length}
                  </span>
                )}
              </div>
              <div className="p-4">
                {hasChunks && chunks[selectedChunk] ? (
                  <div className="prose text-sm">
                    <MarkdownRenderer>{chunks[selectedChunk].content}</MarkdownRenderer>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Select a slice to view its content.</p>
                )}
              </div>
            </div>

            {/* Right: Source preview with highlight */}
            <div className="w-80 shrink-0 rounded-lg border border-border overflow-y-auto" ref={previewRef}>
              <div className="p-2 border-b border-border bg-muted/30">
                <span className="text-xs font-medium text-muted-foreground">Preview Source</span>
              </div>
              <div className="p-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-muted-foreground">
                {source.raw_content ? (
                  highlightRange ? (
                    <>
                      {source.raw_content.slice(0, highlightRange.start)}
                      <mark data-highlight className="bg-yellow-200 dark:bg-yellow-800 text-foreground rounded px-0.5">
                        {source.raw_content.slice(highlightRange.start, highlightRange.end)}
                      </mark>
                      {source.raw_content.slice(highlightRange.end)}
                    </>
                  ) : (
                    source.raw_content
                  )
                ) : (
                  "*No content*"
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Source</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <span className="font-medium text-foreground">"{source.title}"</span>? This action cannot be undone.
          </p>
          {deleteMutation.isError && (
            <p className="text-sm text-destructive">
              {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Delete failed"}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
