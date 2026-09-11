import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, FileText, Upload, ChevronDown, ChevronRight, FolderOpen, Rss, Search, Github, BookOpen, RefreshCw, Download, BookmarkCheck, Trash2, Newspaper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CategorySelect } from "@/components/CategorySelect";
import { PaperDetailDialog, type PaperDetailData } from "@/components/PaperDetailDialog";
import { toPaperResult } from "@/lib/discovery-detail";
import { getSourceProcessingState } from "@/lib/sourceProcessingStatus";
import { sourcesApi, categoriesApi, connectorsApi, type ArxivPaper, type GitHubRepo, type NewsArticle, type SourceCreate, type Source } from "@/lib/api";
import { discoveryApi, type DiscoveryItem } from "@/lib/api";
import { paperDiscoveryApi } from "@/lib/api/paper-discovery";
import { ModuleSectionNav } from "@/components/SectionNav";
import { isRssFeedSource, sourcePresentationLabel } from "@/lib/source-presentation";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { useRouteFocusRestoration } from "@/hooks/useRouteFocusRestoration";
import { useSessionStringSet } from "@/hooks/useSessionStringSet";

const SOURCE_TYPES = ["pdf", "article", "conversation", "video", "web", "github"];
const FEED_VIEWS = [
  { value: "parents", label: "Main Sources" },
  { value: "feeds", label: "Feeds" },
  { value: "articles", label: "Feed Articles" },
  { value: "snapshots", label: "Web Snapshots" },
  { value: "all", label: "All Items" },
];

const PDF_TYPES = [
  { value: "text", label: "一般文字型 (快速)" },
  { value: "ocr", label: "扫描/图片型 (OCR)" },
  { value: "ppt", label: "PPT型" },
  { value: "vlm", label: "不清晰文件 (AI识别)" },
];

/** Files that go through Docling on the server (PDF/Office/images may take a long time, especially with OCR). */
function isServerHeavyExtract(file: File) {
  return /\.(pdf|docx|pptx|xlsx|png|jpe?g|tiff?|bmp|webp|html?)$/i.test(file.name);
}

export function SourcesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const reviewFilter = searchParams.get("review") === "imported" ? "imported" : "";
  const requestedType = searchParams.get("type") ?? "";
  const typeFilter = SOURCE_TYPES.includes(requestedType) ? requestedType : "";
  const newsOnly = searchParams.get("news") === "1";
  const requestedFeedView = searchParams.get("feed") ?? "parents";
  const feedView = FEED_VIEWS.some((view) => view.value === requestedFeedView) ? requestedFeedView : "parents";
  const requestedCategory = Number(searchParams.get("category"));
  const categoryFilter = Number.isInteger(requestedCategory) && requestedCategory > 0 ? requestedCategory : null;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SourceCreate>({ title: "", category_id: 1, source_type: "article" });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [duplicateUploadSource, setDuplicateUploadSource] = useState<Source | null>(null);
  const [pdfType, setPdfType] = useState("text");
  const [collapsedCategories, setCollapsedCategories] = useSessionStringSet("sources-collapsed-categories");
  const [paperForm, setPaperForm] = useState({ query: "", author: "", category: "", paperId: "", maxResults: 5, categoryId: 1 });
  const [githubForm, setGithubForm] = useState({ query: "", fullName: "", language: "", topic: "", minStars: "", maxResults: 5, categoryId: 1, fetchReadme: true });
  const [newsForm, setNewsForm] = useState({ query: "", language: "en", fromDate: "", toDate: "", maxResults: 5, categoryId: 1, fetchFullText: true });
  const [paperResults, setPaperResults] = useState<ArxivPaper[]>([]);
  const [paperDiscoveryItems, setPaperDiscoveryItems] = useState<DiscoveryItem[]>([]);
  const [githubResults, setGithubResults] = useState<GitHubRepo[]>([]);
  const [newsResults, setNewsResults] = useState<NewsArticle[]>([]);
  const [connectorMessage, setConnectorMessage] = useState<string | null>(null);
  const [deleteReviewSource, setDeleteReviewSource] = useState<Source | null>(null);
  const [activePaper, setActivePaper] = useState<PaperDetailData | null>(null);

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const categories = categoriesData?.items ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ["sources", typeFilter, categoryFilter, newsOnly ? "news" : "", feedView, reviewFilter],
    queryFn: () => sourcesApi.list({
      source_type: typeFilter || undefined,
      category_id: categoryFilter ?? undefined,
      kind: newsOnly ? "news" : undefined,
      feed_view: feedView,
      limit: 100,
    }),
  });
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>("sources-list", Boolean(data));
  const { rememberFocus } = useRouteFocusRestoration("sources-list", Boolean(data));

  const visibleSources = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((source) => {
      if (reviewFilter === "imported" && source.metadata_?.review_status !== "imported_reviewable") {
        return false;
      }
      return true;
    });
  }, [data?.items, reviewFilter]);

  // Group sources by category
  const groupedSources = useMemo(() => {
    if (!visibleSources.length) return [];
    const groups = new Map<string, { categoryId: number; categoryName: string; displayName: string; sources: Source[] }>();

    for (const source of visibleSources) {
      const key = source.category_name || "general";
      if (!groups.has(key)) {
        const cat = categories.find((c) => c.name === key);
        groups.set(key, {
          categoryId: source.category_id,
          categoryName: key,
          displayName: cat?.display_name || key,
          sources: [],
        });
      }
      groups.get(key)!.sources.push(source);
    }

    return [...groups.values()].sort((a, b) => {
      if (a.categoryName === "general") return 1;
      if (b.categoryName === "general") return -1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [visibleSources, categories]);

  const toggleCategory = (name: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: sourcesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setOpen(false);
      setForm({ title: "", category_id: 1, source_type: "article" });
      setUploadFile(null);
      setPdfType("text");
    },
  });

  const uploadMutation = useMutation({
    mutationFn: sourcesApi.upload,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      if (result.duplicate) {
        setDuplicateUploadSource(result);
        return;
      }
      setOpen(false);
      setForm({ title: "", category_id: 1, source_type: "article" });
      setUploadFile(null);
      setDuplicateUploadSource(null);
      setPdfType("text");
    },
  });

  const paperSearchMutation = useMutation({
    mutationFn: async () => {
      const baseName = `Paper search: ${paperForm.query || paperForm.paperId || "manual"}`;
      let profile;
      try {
        profile = await paperDiscoveryApi.createProfile({
          name: baseName,
          goal_prompt: paperForm.query || paperForm.paperId || "paper search",
          mode: "query",
          provider: "openalex",
          schedule: "manual",
          max_results: paperForm.maxResults,
          include_terms: [paperForm.query].filter(Boolean),
          preferred_authors: [paperForm.author].filter(Boolean),
          preferred_arxiv_categories: [paperForm.category].filter(Boolean),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("409")) {
          throw error;
        }
        const profiles = await paperDiscoveryApi.listProfiles();
        profile = profiles.items.find((item) => item.name === baseName);
        if (!profile) {
          throw error;
        }
      }
      await paperDiscoveryApi.runProfile(profile.id, { limit: paperForm.maxResults });
      return paperDiscoveryApi.listCandidates(profile.id, paperForm.maxResults);
    },
    onSuccess: (result) => {
      setPaperDiscoveryItems(result.items);
      const items = result.items.map(toPaperResult);
      setPaperResults(items);
      setConnectorMessage(`Found ${result.total} paper(s) via OpenAlex.`);
    },
  });

  const paperImportMutation = useMutation({
    mutationFn: async (paper: ArxivPaper) => {
      const discoveryItem = paperDiscoveryItems.find((item) => String(item.payload?.arxiv_id || item.item_key) === paper.arxiv_id);
      if (discoveryItem) {
        return discoveryApi.feedback(discoveryItem.id, "save");
      }
      const result = await connectorsApi.importArxiv({ paper, category_id: paperForm.categoryId });
      return { item: null, source: result.source, created: result.created };
    },
    onSuccess: (result, paper) => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["paper-discovery-candidates"] });
      setPaperResults((items) => items.map((item) => item.arxiv_id === paper.arxiv_id ? { ...item, cache_status: "saved", cache_expires_at: null, source_id: result.source?.id ?? item.source_id } : item));
      if (result.item) {
        setPaperDiscoveryItems((items) => items.map((item) => item.id === result.item!.id ? result.item! : item));
      }
      updateViewParams({ type: "article", news: null, feed: null, review: null });
      setConnectorMessage(`${result.created ? "Imported" : "Updated"} ${result.source?.title ?? paper.title}`);
    },
  });

  const githubSearchMutation = useMutation({
    mutationFn: () => connectorsApi.searchGitHub({
      query: githubForm.query,
      language: githubForm.language || undefined,
      topic: githubForm.topic || undefined,
      min_stars: githubForm.minStars ? Number(githubForm.minStars) : undefined,
      max_results: githubForm.maxResults,
    }),
    onSuccess: (result) => {
      setGithubResults(result.items);
      setConnectorMessage(`Found ${result.total} GitHub repo(s). Unsaved results are cached for 7 days.`);
    },
  });

  const githubImportMutation = useMutation({
    mutationFn: (repo: GitHubRepo) => connectorsApi.importGitHub({ repo, category_id: githubForm.categoryId, fetch_readme: githubForm.fetchReadme }),
    onSuccess: (result, repo) => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setGithubResults((items) => items.map((item) => item.full_name === repo.full_name ? { ...item, cache_status: "saved", cache_expires_at: null, source_id: result.source.id } : item));
      updateViewParams({ type: "github", news: null, feed: null, review: null });
      setConnectorMessage(`${result.created ? "Kept" : "Updated"} ${result.source.title}`);
    },
  });

  const githubDirectImportMutation = useMutation({
    mutationFn: () => connectorsApi.importGitHub({ full_name: githubForm.fullName, category_id: githubForm.categoryId, fetch_readme: githubForm.fetchReadme }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      updateViewParams({ type: "github", news: null, feed: null, review: null });
      setConnectorMessage(`${result.created ? "Kept" : "Updated"} ${result.source.title}`);
    },
  });

  const newsSearchMutation = useMutation({
    mutationFn: () => connectorsApi.searchNews({
      query: newsForm.query,
      language: newsForm.language || undefined,
      from_date: newsForm.fromDate || undefined,
      to_date: newsForm.toDate || undefined,
      max_results: newsForm.maxResults,
    }),
    onSuccess: (result) => {
      setNewsResults(result.items);
      setConnectorMessage(`Found ${result.total} news article(s). Unsaved results are cached for 7 days.`);
    },
  });

  const newsImportMutation = useMutation({
    mutationFn: (article: NewsArticle) => connectorsApi.importNews({ article, category_id: newsForm.categoryId, fetch_full_text: newsForm.fetchFullText }),
    onSuccess: (result, article) => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setNewsResults((items) => items.map((item) => item.url === article.url ? { ...item, cache_status: "saved", cache_expires_at: null, source_id: result.source.id } : item));
      updateViewParams({ type: "article", feed: null, review: null });
      setConnectorMessage(`${result.created ? "Kept" : "Updated"} ${result.source.title}`);
    },
  });

  const keepImportedMutation = useMutation({
    mutationFn: (id: string) => sourcesApi.keepImported(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["review-summary"] });
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: (id: string) => sourcesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["review-summary"] });
      setDeleteReviewSource(null);
    },
  });

  function buildUploadPayload() {
    if (!uploadFile) return null;
    const payload = new FormData();
    payload.append("file", uploadFile);
    payload.append("title", form.title || uploadFile.name.replace(/\.[^.]+$/, ""));
    payload.append("source_type", form.source_type);
    payload.append("category_id", String(form.category_id));
    payload.append("url", form.url || "");
    if (/\.pdf$/i.test(uploadFile.name)) {
      payload.append("pdf_type", pdfType);
    }
    return payload;
  }

  function submitSource() {
    const payload = buildUploadPayload();
    if (payload) {
      uploadMutation.mutate(payload);
      return;
    }
    createMutation.mutate(form);
  }

  const showGrouped = categoryFilter === null && groupedSources.length > 1;
  const hasSources = visibleSources.length > 0;

  const clearReviewFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("review");
    setSearchParams(next, { replace: true });
  };

  const updateViewParams = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };

  const sourceDetailState = useMemo(() => ({
    backTo: `/sources${searchParams.toString() ? `?${searchParams.toString()}` : ""}`,
    backLabel: reviewFilter === "imported" ? "Back to Imported Review" : "Back to Sources",
  }), [reviewFilter, searchParams]);

  return (
    <>
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" data-route-scroll="sources-list">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <ModuleSectionNav parent="knowledge" active="Sources" />

        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Sources</h1>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4" /> New Source</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Source</DialogTitle>
                <p className="text-sm text-muted-foreground">
                  Sources are external evidence you want to keep with provenance, such as web pages, PDFs, RSS articles, GitHub repos, and imported documents.
                </p>
                <p className="text-xs text-muted-foreground">
                  If this is your own writing or an agent response, save it as a note or writing document instead.
                </p>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Title"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
                <div className="flex gap-2 flex-wrap">
                  <select
                    className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-40"
                    value={form.source_type}
                    onChange={(e) => setForm({ ...form, source_type: e.target.value })}
                  >
                    {SOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <CategorySelect
                    categories={categories}
                    value={form.category_id}
                    onChange={(id) => setForm({ ...form, category_id: id })}
                  />
                  <Input
                    placeholder="URL (optional)"
                    value={form.url || ""}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    className="flex-1 min-w-[120px]"
                  />
                </div>
                <Textarea
                  placeholder={form.source_type === "web" && form.url ? "Content (optional: leave empty to fetch readable page text from URL)" : "Content"}
                  rows={8}
                  value={form.raw_content || ""}
                  onChange={(e) => setForm({ ...form, raw_content: e.target.value })}
                />
                {form.source_type === "web" && form.url && !form.raw_content && (
                  <p className="text-xs text-muted-foreground">
                    Web sources with an empty content field will fetch and extract readable page text from the URL.
                  </p>
                )}
                <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Upload className="h-4 w-4" />
                    Upload the original file and store it in MinIO.
                  </div>
                  <Input
                    type="file"
                    onChange={(e) => {
                      const nextFile = e.target.files?.[0] || null;
                      uploadMutation.reset();
                      setDuplicateUploadSource(null);
                      setUploadFile(nextFile);
                      if (nextFile && !form.title) {
                        setForm({ ...form, title: nextFile.name.replace(/\.[^.]+$/, "") });
                      }
                    }}
                  />
                  {uploadFile && (
                    <p className="text-xs text-muted-foreground">Selected file: {uploadFile.name}</p>
                  )}
                  {duplicateUploadSource && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950" role="status">
                      <p className="font-medium">This file already exists. No upload was needed.</p>
                      <p className="mt-1 text-xs text-amber-800">Existing Source: {duplicateUploadSource.title}</p>
                      <Button
                        className="mt-3"
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/sources/${encodeURIComponent(duplicateUploadSource.id)}`)}
                      >
                        Open existing Source
                      </Button>
                    </div>
                  )}
                  {uploadFile && /\.pdf$/i.test(uploadFile.name) && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">PDF type:</span>
                      <select
                        className="flex h-8 rounded-md border border-input bg-transparent px-2 py-1 text-xs"
                        value={pdfType}
                        onChange={(e) => setPdfType(e.target.value)}
                      >
                        {PDF_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                {uploadMutation.isPending && uploadFile && isServerHeavyExtract(uploadFile) && pdfType === "vlm" && (
                  <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/50 px-3 py-2">
                    AI正在逐页识别文档，大文档可能需要较长时间。进度日志:{" "}
                    <span className="font-mono text-[10px]">[vlm] requesting page x/y</span>
                  </p>
                )}
                {uploadMutation.isPending && uploadFile && isServerHeavyExtract(uploadFile) && pdfType !== "text" && pdfType !== "vlm" && (
                  <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/50 px-3 py-2">
                    Server is extracting text (Docling). Large PDFs with OCR can take several minutes. Page progress
                    appears in the API process logs as{" "}
                    <span className="font-mono text-[10px]">[docling] PDF progress: x/y pages</span>.
                  </p>
                )}
                <Button
                  className="w-full"
                  onClick={submitSource}
                  disabled={!form.title || createMutation.isPending || uploadMutation.isPending || Boolean(duplicateUploadSource)}
                >
                  {uploadMutation.isPending
                    ? uploadFile && pdfType === "vlm"
                      ? "AI识别中..."
                      : uploadFile && isServerHeavyExtract(uploadFile) && pdfType !== "text"
                        ? "Processing on server..."
                        : "Uploading..."
                    : createMutation.isPending
                      ? "Creating..."
                      : uploadFile
                        ? duplicateUploadSource
                          ? "Already uploaded"
                          : "Upload & Create"
                        : "Create"}
                </Button>
                {(uploadMutation.isError || createMutation.isError) && (
                  <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                    {uploadMutation.error instanceof Error
                      ? `Upload failed: ${uploadMutation.error.message}`
                      : createMutation.error instanceof Error
                        ? `Create failed: ${createMutation.error.message}`
                        : "Unable to create this Source."}
                  </p>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Category filter */}
        <div className="flex gap-2 mb-2 flex-wrap">
          {reviewFilter === "imported" && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
              Showing imported sources pending review
              <button type="button" className="font-medium underline" onClick={clearReviewFilter}>Clear</button>
            </div>
          )}
          <button
            onClick={() => updateViewParams({ category: null })}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              categoryFilter === null ? "bg-emerald-500/20 text-emerald-600 font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All Categories
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => updateViewParams({ category: String(c.id) })}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                categoryFilter === c.id ? "bg-emerald-500/20 text-emerald-600 font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {c.display_name}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex gap-2 mb-2 flex-wrap">
          <button
            onClick={() => updateViewParams({ type: null, news: null, review: null })}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              !typeFilter ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </button>
          {SOURCE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => updateViewParams({ type: t, news: null, review: null })}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                typeFilter === t ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {t}
            </button>
          ))}
          <button
            onClick={() => updateViewParams({ type: "article", news: newsOnly ? null : "1", review: null })}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              newsOnly ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            news
          </button>
        </div>


        {typeFilter === "article" && (
          <>
            <ArxivConnectorPanel
              categories={categories}
              form={paperForm}
              setForm={setPaperForm}
              results={paperResults}
              onSearch={() => paperSearchMutation.mutate()}
              onImport={(paper) => paperImportMutation.mutate(paper)}
              onOpenDetail={(paper) => setActivePaper({
                title: paper.title,
                authors: paper.authors,
                abstract: paper.abstract,
                url: paper.entry_url,
                pdf_url: paper.pdf_url,
                doi: paper.doi,
                arxiv_id: paper.arxiv_id,
                categories: paper.categories,
                provider: "openalex",
              })}
              isSearching={paperSearchMutation.isPending}
              importingId={paperImportMutation.variables?.arxiv_id ?? null}
              error={paperSearchMutation.error instanceof Error ? paperSearchMutation.error.message : paperImportMutation.error instanceof Error ? paperImportMutation.error.message : null}
              message={connectorMessage}
            />

            <NewsConnectorPanel
              categories={categories}
              form={newsForm}
              setForm={setNewsForm}
              results={newsResults}
              onSearch={() => newsSearchMutation.mutate()}
              onImport={(article) => newsImportMutation.mutate(article)}
              isSearching={newsSearchMutation.isPending}
              importingUrl={newsImportMutation.variables?.url ?? null}
              error={newsSearchMutation.error instanceof Error ? newsSearchMutation.error.message : newsImportMutation.error instanceof Error ? newsImportMutation.error.message : null}
              message={connectorMessage}
            />
          </>
        )}

        {typeFilter === "github" && (
          <GitHubConnectorPanel
            categories={categories}
            form={githubForm}
            setForm={setGithubForm}
            results={githubResults}
            onSearch={() => githubSearchMutation.mutate()}
            onImport={(repo) => githubImportMutation.mutate(repo)}
            onDirectImport={() => githubDirectImportMutation.mutate()}
            isSearching={githubSearchMutation.isPending}
            isDirectImporting={githubDirectImportMutation.isPending}
            importingName={githubImportMutation.variables?.full_name ?? null}
            error={githubSearchMutation.error instanceof Error ? githubSearchMutation.error.message : githubImportMutation.error instanceof Error ? githubImportMutation.error.message : githubDirectImportMutation.error instanceof Error ? githubDirectImportMutation.error.message : null}
            message={connectorMessage}
          />
        )}

        {/* Feed view filter */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {FEED_VIEWS.map((view) => (
            <button
              key={view.value}
              onClick={() => updateViewParams({ feed: view.value === "parents" ? null : view.value })}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                feedView === view.value ? "bg-orange-500/20 text-orange-600 font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {view.label}
            </button>
          ))}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {data && !hasSources && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <FileText className="h-12 w-12 mb-3 opacity-30" />
            <p>{reviewFilter === "imported" ? "No imported sources pending review." : "No sources yet. Add external material here when you want to keep it as evidence with provenance."}</p>
          </div>
        )}

        {hasSources && (showGrouped ? (
          <div className="space-y-6">
            {groupedSources.map((group) => {
              const isCollapsed = collapsedCategories.has(group.categoryName);
              return (
                <div key={group.categoryName}>
                  <button
                    onClick={() => toggleCategory(group.categoryName)}
                    className="flex items-center gap-2 mb-3 cursor-pointer group"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                    <FolderOpen className="h-4 w-4 text-emerald-500" />
                    <span className="text-sm font-semibold">{group.displayName}</span>
                    <span className="text-xs text-muted-foreground">({group.sources.length})</span>
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-1">
                      {group.sources.map((source) => (
                        <SourceRow
                          key={source.id}
                          source={source}
                          onClick={() => { rememberFocus(source.id); navigate(`/sources/${encodeURIComponent(source.id)}`, { state: sourceDetailState }); }}
                          reviewMode={reviewFilter === "imported"}
                          onKeep={() => keepImportedMutation.mutate(source.id)}
                          onDelete={() => setDeleteReviewSource(source)}
                          isKeeping={keepImportedMutation.isPending && keepImportedMutation.variables === source.id}
                          isDeleting={deleteSourceMutation.isPending && deleteSourceMutation.variables === source.id}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {visibleSources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                onClick={() => { rememberFocus(source.id); navigate(`/sources/${encodeURIComponent(source.id)}`, { state: sourceDetailState }); }}
                reviewMode={reviewFilter === "imported"}
                onKeep={() => keepImportedMutation.mutate(source.id)}
                onDelete={() => setDeleteReviewSource(source)}
                isKeeping={keepImportedMutation.isPending && keepImportedMutation.variables === source.id}
                isDeleting={deleteSourceMutation.isPending && deleteSourceMutation.variables === source.id}
              />
            ))}
          </div>
        ))}
      </div>

        <Dialog open={Boolean(deleteReviewSource)} onOpenChange={(open) => !open && setDeleteReviewSource(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Imported Source?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Delete <span className="font-medium text-foreground">{deleteReviewSource?.title}</span> from your sources. This cannot be undone.
            </p>
            {deleteSourceMutation.error && (
              <p className="text-sm text-destructive">{deleteSourceMutation.error instanceof Error ? deleteSourceMutation.error.message : "Delete failed"}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteReviewSource(null)} disabled={deleteSourceMutation.isPending}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={() => deleteReviewSource && deleteSourceMutation.mutate(deleteReviewSource.id)} disabled={deleteSourceMutation.isPending}>
                {deleteSourceMutation.isPending ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
    </div>
    <PaperDetailDialog open={Boolean(activePaper)} onOpenChange={(open) => { if (!open) setActivePaper(null); }} paper={activePaper} />
    </>
  );
}

function SourceRow({
  source,
  onClick,
  reviewMode = false,
  onKeep,
  onDelete,
  isKeeping = false,
  isDeleting = false,
}: {
  source: Source;
  onClick: () => void;
  reviewMode?: boolean;
  onKeep?: () => void;
  onDelete?: () => void;
  isKeeping?: boolean;
  isDeleting?: boolean;
}) {
  const isRss = isRssFeedSource(source);
  const isFeedArticle = Boolean(source.metadata_?.feed_source_id);
  const isNews = source.source_type === "article" && source.metadata_?.kind === "news";
  const sourceName = typeof source.metadata_?.source_name === "string" ? source.metadata_.source_name : null;
  const publishedAt = typeof source.metadata_?.published_at === "string" ? source.metadata_.published_at : null;
  const label = sourcePresentationLabel(source);
  const processing = getSourceProcessingState(source);
  return (
    <div
      role="link"
      tabIndex={0}
      data-route-focus-id={source.id}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:border-border hover:bg-accent/50 cursor-pointer transition-colors"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <Badge variant="source" className="shrink-0">{label}</Badge>
      {isNews && <Badge variant="secondary" className="shrink-0">news</Badge>}
      <Badge variant="outline" className="shrink-0">{processing.label}</Badge>
      {isRss && <Rss className="h-3.5 w-3.5 text-orange-500 shrink-0" />}
      <span className="text-sm font-medium truncate flex-1">{source.title}</span>
      {isNews && sourceName && (
        <span className="text-xs text-muted-foreground truncate max-w-[140px] hidden lg:block">{sourceName}</span>
      )}
      {source.url && (
        <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden md:block">{source.url}</span>
      )}
      <span className="text-xs text-muted-foreground shrink-0">
        {publishedAt ? new Date(publishedAt).toLocaleDateString() : new Date(source.ingested_at).toLocaleDateString()}
      </span>
      {reviewMode && (
        <div className="flex shrink-0 gap-2" onClick={(event) => event.stopPropagation()}>
          <Button size="sm" variant="outline" onClick={onKeep} disabled={isKeeping || isDeleting}>
            {isKeeping ? <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" /> : <BookmarkCheck className="mr-1 h-3.5 w-3.5" />} Keep
          </Button>
          <Button size="sm" variant="destructive" onClick={onDelete} disabled={isKeeping || isDeleting}>
            {isDeleting ? <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />} Delete
          </Button>
        </div>
      )}
    </div>
  );
}

type CategoryOption = Parameters<typeof CategorySelect>[0]["categories"][number];
type ArxivForm = { query: string; author: string; category: string; paperId: string; maxResults: number; categoryId: number };
type GitHubForm = { query: string; fullName: string; language: string; topic: string; minStars: string; maxResults: number; categoryId: number; fetchReadme: boolean };
type NewsForm = { query: string; language: string; fromDate: string; toDate: string; maxResults: number; categoryId: number; fetchFullText: boolean };

function ArxivConnectorPanel({
  categories,
  form,
  setForm,
  results,
  onSearch,
  onImport,
  onOpenDetail,
  isSearching,
  importingId,
  error,
  message,
}: {
  categories: CategoryOption[];
  form: ArxivForm;
  setForm: React.Dispatch<React.SetStateAction<ArxivForm>>;
  results: ArxivPaper[];
  onSearch: () => void;
  onImport: (paper: ArxivPaper) => void;
  onOpenDetail: (paper: ArxivPaper) => void;
  isSearching: boolean;
  importingId: string | null;
  error: string | null;
  message: string | null;
}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4" /> Paper Search</h2>
          <p className="text-xs text-muted-foreground">Paper search runs through OpenAlex. Click Keep to save a paper as a permanent article Source.</p>
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Input placeholder="Query, e.g. agentic rag" value={form.query} onChange={(e) => setForm((current) => ({ ...current, query: e.target.value }))} />
          <Input placeholder="Author" value={form.author} onChange={(e) => setForm((current) => ({ ...current, author: e.target.value }))} />
          <Input placeholder="Field/category, e.g. agents or cs.AI" value={form.category} onChange={(e) => setForm((current) => ({ ...current, category: e.target.value }))} />
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_120px_minmax(180px,220px)_auto]">
          <Input placeholder="Paper ID optional (arXiv id supported)" value={form.paperId} onChange={(e) => setForm((current) => ({ ...current, paperId: e.target.value }))} />
          <Input type="number" min={1} max={50} value={form.maxResults} onChange={(e) => setForm((current) => ({ ...current, maxResults: Number(e.target.value) || 5 }))} />
          <CategorySelect categories={categories} value={form.categoryId} onChange={(id) => setForm((current) => ({ ...current, categoryId: id }))} />
          <Button type="button" disabled={isSearching || (!form.query && !form.paperId && !form.author && !form.category)} onClick={onSearch}>
            {isSearching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="space-y-2">
          {results.map((paper) => (
            <button
              key={paper.arxiv_id}
              type="button"
              className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
              onClick={() => onOpenDetail(paper)}
            >
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="source">article</Badge>
                    <Badge variant="outline">{paper.arxiv_id}</Badge>
                    {paper.categories.slice(0, 3).map((category) => <Badge key={category} variant="secondary">{category}</Badge>)}
                  </div>
                  <div className="mt-2 text-sm font-medium leading-5 hover:text-primary">{paper.title}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{paper.authors.slice(0, 5).join(", ")}</p>
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{paper.abstract}</p>
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <ConnectorCacheStatus status={paper.cache_status} expiresAt={paper.cache_expires_at} sourceId={paper.source_id} />
                  <Button type="button" size="sm" variant={paper.cache_status === "saved" ? "secondary" : "outline"} disabled={importingId === paper.arxiv_id || paper.cache_status === "saved"} onClick={(event) => { event.stopPropagation(); onImport(paper); }}>
                    {importingId === paper.arxiv_id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <BookmarkCheck className="h-3.5 w-3.5" />} {paper.cache_status === "saved" ? "Kept" : "Keep"}
                  </Button>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConnectorCacheStatus({ status, expiresAt, sourceId }: { status?: string | null; expiresAt?: string | null; sourceId?: string | null }) {
  if (status === "saved") {
    return <span className="text-xs text-emerald-600">Kept permanently{sourceId ? ` · ${sourceId}` : ""}</span>;
  }
  if (expiresAt) {
    return <span className="text-xs text-muted-foreground">Temporary · expires {new Date(expiresAt).toLocaleDateString()}</span>;
  }
  return <span className="text-xs text-muted-foreground">Temporary · 7 days</span>;
}

function GitHubConnectorPanel({
  categories,
  form,
  setForm,
  results,
  onSearch,
  onImport,
  onDirectImport,
  isSearching,
  isDirectImporting,
  importingName,
  error,
  message,
}: {
  categories: CategoryOption[];
  form: GitHubForm;
  setForm: React.Dispatch<React.SetStateAction<GitHubForm>>;
  results: GitHubRepo[];
  onSearch: () => void;
  onImport: (repo: GitHubRepo) => void;
  onDirectImport: () => void;
  isSearching: boolean;
  isDirectImporting: boolean;
  importingName: string | null;
  error: string | null;
  message: string | null;
}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Github className="h-4 w-4" /> GitHub Source Search</h2>
          <p className="text-xs text-muted-foreground">Search results are temporary for 7 days. Click Keep to save a repository as a permanent github source.</p>
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <Input placeholder="Direct import owner/repo, e.g. openai/codex" value={form.fullName} onChange={(e) => setForm((current) => ({ ...current, fullName: e.target.value }))} />
          <Button type="button" variant="outline" disabled={!form.fullName || isDirectImporting} onClick={onDirectImport}>
            {isDirectImporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Keep Repo
          </Button>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Input placeholder="Search query, e.g. agent framework" value={form.query} onChange={(e) => setForm((current) => ({ ...current, query: e.target.value }))} />
          <Input placeholder="Language" value={form.language} onChange={(e) => setForm((current) => ({ ...current, language: e.target.value }))} />
          <Input placeholder="Topic" value={form.topic} onChange={(e) => setForm((current) => ({ ...current, topic: e.target.value }))} />
        </div>
        <div className="grid gap-2 md:grid-cols-[140px_120px_minmax(180px,220px)_auto]">
          <Input placeholder="Min stars" type="number" min={0} value={form.minStars} onChange={(e) => setForm((current) => ({ ...current, minStars: e.target.value }))} />
          <Input type="number" min={1} max={50} value={form.maxResults} onChange={(e) => setForm((current) => ({ ...current, maxResults: Number(e.target.value) || 5 }))} />
          <CategorySelect categories={categories} value={form.categoryId} onChange={(id) => setForm((current) => ({ ...current, categoryId: id }))} />
          <Button type="button" disabled={!form.query || isSearching} onClick={onSearch}>
            {isSearching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={form.fetchReadme} onChange={(e) => setForm((current) => ({ ...current, fetchReadme: e.target.checked }))} />
          Fetch README on direct keep. Search result keeps create github sources from repo metadata first.
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="space-y-2">
          {results.map((repo) => (
            <div key={repo.full_name} className="rounded-lg border border-border p-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="source">github</Badge>
                    <Badge variant="outline">★ {repo.stars}</Badge>
                    {repo.language && <Badge variant="secondary">{repo.language}</Badge>}
                    {repo.topics.slice(0, 3).map((topic) => <Badge key={topic} variant="outline">{topic}</Badge>)}
                  </div>
                  <h3 className="mt-2 text-sm font-medium leading-5">{repo.full_name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{repo.description || "No description."}</p>
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <ConnectorCacheStatus status={repo.cache_status} expiresAt={repo.cache_expires_at} sourceId={repo.source_id} />
                  <Button type="button" size="sm" variant={repo.cache_status === "saved" ? "secondary" : "outline"} disabled={importingName === repo.full_name || repo.cache_status === "saved"} onClick={() => onImport(repo)}>
                    {importingName === repo.full_name ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <BookmarkCheck className="h-3.5 w-3.5" />} {repo.cache_status === "saved" ? "Kept" : "Keep"}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewsConnectorPanel({
  categories,
  form,
  setForm,
  results,
  onSearch,
  onImport,
  isSearching,
  importingUrl,
  error,
  message,
}: {
  categories: Awaited<ReturnType<typeof categoriesApi.list>>["items"];
  form: NewsForm;
  setForm: React.Dispatch<React.SetStateAction<NewsForm>>;
  results: NewsArticle[];
  onSearch: () => void;
  onImport: (article: NewsArticle) => void;
  isSearching: boolean;
  importingUrl: string | null;
  error: string | null;
  message: string | null;
}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Newspaper className="h-4 w-4" /> News Search</h2>
          <p className="text-xs text-muted-foreground">Search and keep news articles as article sources with news metadata.</p>
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_120px_120px]">
          <Input placeholder="Search query, e.g. OpenAI" value={form.query} onChange={(e) => setForm((current) => ({ ...current, query: e.target.value }))} />
          <Input placeholder="Language" value={form.language} onChange={(e) => setForm((current) => ({ ...current, language: e.target.value }))} />
          <Input type="number" min={1} max={50} value={form.maxResults} onChange={(e) => setForm((current) => ({ ...current, maxResults: Number(e.target.value) || 5 }))} />
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(180px,220px)_auto]">
          <Input type="date" value={form.fromDate} onChange={(e) => setForm((current) => ({ ...current, fromDate: e.target.value }))} />
          <Input type="date" value={form.toDate} onChange={(e) => setForm((current) => ({ ...current, toDate: e.target.value }))} />
          <CategorySelect categories={categories} value={form.categoryId} onChange={(id) => setForm((current) => ({ ...current, categoryId: id }))} />
          <Button type="button" disabled={!form.query || isSearching} onClick={onSearch}>
            {isSearching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={form.fetchFullText} onChange={(e) => setForm((current) => ({ ...current, fetchFullText: e.target.checked }))} />
          Try fetching readable full text when saving.
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="space-y-2">
          {results.map((article) => (
            <div key={article.url} className="rounded-lg border border-border p-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="source">news</Badge>
                    {article.source_name && <Badge variant="outline">{article.source_name}</Badge>}
                    {article.published_at && <Badge variant="secondary">{new Date(article.published_at).toLocaleDateString()}</Badge>}
                  </div>
                  <h3 className="mt-2 text-sm font-medium leading-5">{article.title}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{article.description || article.content || article.url}</p>
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <ConnectorCacheStatus status={article.cache_status} expiresAt={article.cache_expires_at} sourceId={article.source_id} />
                  <Button type="button" size="sm" variant={article.cache_status === "saved" ? "secondary" : "outline"} disabled={importingUrl === article.url || article.cache_status === "saved"} onClick={() => onImport(article)}>
                    {importingUrl === article.url ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <BookmarkCheck className="h-3.5 w-3.5" />} {article.cache_status === "saved" ? "Kept" : "Keep"}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
