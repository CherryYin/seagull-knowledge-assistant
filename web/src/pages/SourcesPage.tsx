import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sourcesApi, type SourceCreate } from "@/lib/api";

const SOURCE_TYPES = ["pdf", "article", "conversation", "video", "web", "code"];

/** Files that go through Docling on the server (PDF/Office/images may take a long time, especially with OCR). */
function isServerHeavyExtract(file: File) {
  return /\.(pdf|docx|pptx|xlsx|png|jpe?g|tiff?|bmp|webp|html?)$/i.test(file.name);
}

export function SourcesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SourceCreate>({ title: "", source_type: "article" });
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["sources", typeFilter],
    queryFn: () => sourcesApi.list({ source_type: typeFilter || undefined, limit: 50 }),
  });

  const createMutation = useMutation({
    mutationFn: sourcesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setOpen(false);
      setForm({ title: "", source_type: "article" });
      setUploadFile(null);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: sourcesApi.upload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setOpen(false);
      setForm({ title: "", source_type: "article" });
      setUploadFile(null);
    },
  });

  function buildUploadPayload() {
    if (!uploadFile) return null;
    const payload = new FormData();
    payload.append("file", uploadFile);
    payload.append("title", form.title || uploadFile.name.replace(/\.[^.]+$/, ""));
    payload.append("source_type", form.source_type);
    payload.append("url", form.url || "");
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
                <div className="flex gap-2">
                  <select
                    className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-40"
                    value={form.source_type}
                    onChange={(e) => setForm({ ...form, source_type: e.target.value })}
                  >
                    {SOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <Input
                    placeholder="URL (optional)"
                    value={form.url || ""}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
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
                </div>
                {uploadMutation.isPending && uploadFile && isServerHeavyExtract(uploadFile) && (
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
                    ? uploadFile && isServerHeavyExtract(uploadFile)
                      ? "Processing on server…"
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

        <div className="grid gap-3 md:grid-cols-2">
          {data?.items.map((source) => (
            <Card
              key={source.id}
              className="cursor-pointer hover:border-primary/40 transition-colors"
              onClick={() => navigate(`/sources/${encodeURIComponent(source.id)}`)}
            >
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
          ))}
        </div>
      </div>
    </div>
  );
}
