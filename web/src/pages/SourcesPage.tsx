import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, FileText, Upload, ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CategorySelect } from "@/components/CategorySelect";
import { sourcesApi, categoriesApi, type SourceCreate, type Source } from "@/lib/api";

const SOURCE_TYPES = ["pdf", "article", "conversation", "video", "web", "code"];

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
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SourceCreate>({ title: "", category_id: 1, source_type: "article" });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [pdfType, setPdfType] = useState("text");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const categories = categoriesData?.items ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ["sources", typeFilter, categoryFilter],
    queryFn: () => sourcesApi.list({ source_type: typeFilter || undefined, category_id: categoryFilter ?? undefined, limit: 100 }),
  });

  // Group sources by category
  const groupedSources = useMemo(() => {
    if (!data?.items) return [];
    const groups = new Map<string, { categoryId: number; categoryName: string; displayName: string; sources: Source[] }>();

    for (const source of data.items) {
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
  }, [data?.items, categories]);

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setOpen(false);
      setForm({ title: "", category_id: 1, source_type: "article" });
      setUploadFile(null);
      setPdfType("text");
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Sources</h1>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4" /> New Source</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Source</DialogTitle>
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
                  placeholder="Content"
                  rows={8}
                  value={form.raw_content || ""}
                  onChange={(e) => setForm({ ...form, raw_content: e.target.value })}
                />
                <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Upload className="h-4 w-4" />
                    Upload the original file and store it in MinIO.
                  </div>
                  <Input
                    type="file"
                    onChange={(e) => {
                      const nextFile = e.target.files?.[0] || null;
                      setUploadFile(nextFile);
                      if (nextFile && !form.title) {
                        setForm({ ...form, title: nextFile.name.replace(/\.[^.]+$/, "") });
                      }
                    }}
                  />
                  {uploadFile && (
                    <p className="text-xs text-muted-foreground">Selected file: {uploadFile.name}</p>
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
                  disabled={!form.title || createMutation.isPending || uploadMutation.isPending}
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
                        ? "Upload & Create"
                        : "Create"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Category filter */}
        <div className="flex gap-2 mb-2 flex-wrap">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              categoryFilter === null ? "bg-emerald-500/20 text-emerald-600 font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All Categories
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategoryFilter(c.id)}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                categoryFilter === c.id ? "bg-emerald-500/20 text-emerald-600 font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {c.display_name}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => setTypeFilter("")}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              !typeFilter ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </button>
          {SOURCE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                typeFilter === t ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {data && data.total === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <FileText className="h-12 w-12 mb-3 opacity-30" />
            <p>No sources yet. Add one to get started.</p>
          </div>
        )}

        {showGrouped ? (
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
                    <div className="grid gap-3 md:grid-cols-2">
                      {group.sources.map((source) => (
                        <SourceCard key={source.id} source={source} onClick={() => navigate(`/sources/${encodeURIComponent(source.id)}`)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data?.items.map((source) => (
              <SourceCard key={source.id} source={source} onClick={() => navigate(`/sources/${encodeURIComponent(source.id)}`)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceCard({ source, onClick }: { source: Source; onClick: () => void }) {
  return (
    <Card className="cursor-pointer hover:border-primary/40 transition-colors" onClick={onClick}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="source">{source.source_type}</Badge>
        </div>
        <CardTitle className="text-sm">{source.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {source.url && (
          <p className="text-xs text-primary truncate">{source.url}</p>
        )}
        <p className="text-[10px] text-muted-foreground mt-2">
          {new Date(source.ingested_at).toLocaleDateString()}
        </p>
      </CardContent>
    </Card>
  );
}
