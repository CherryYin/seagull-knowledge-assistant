import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Download, ExternalLink, Trash2, List, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sourcesApi, type SourceChunk } from "@/lib/api";

type ViewMode = "full" | "slices";

export function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("full");
  const [selectedChunk, setSelectedChunk] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);

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

  const deleteMutation = useMutation({
    mutationFn: () => sourcesApi.delete(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      navigate("/sources");
    },
  });

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
  if (error || !source) return <div className="p-8 text-destructive">Source not found.</div>;

  const hasChunks = chunks && chunks.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => navigate("/sources")}>
            <ArrowLeft className="h-4 w-4" /> Back to Sources
          </Button>
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
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="source">{source.source_type}</Badge>
            {source.category_name && source.category_name !== "general" && (
              <Badge variant="secondary">{source.category_name}</Badge>
            )}
          </div>
          <h1 className="text-2xl font-bold">{source.title}</h1>
          {source.url && (
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1">
              {source.url} <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {source.file_path && (
            <div className="mt-3">
              <Button asChild variant="outline" size="sm">
                <a href={`/api/sources/${encodeURIComponent(source.id)}/file`} target="_blank" rel="noopener noreferrer">
                  <Download className="h-4 w-4" /> Open Stored File
                </a>
              </Button>
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-2 space-x-4">
            <span>Ingested: {new Date(source.ingested_at).toLocaleString()}</span>
            <span className="font-mono">{source.id}</span>
          </div>
        </div>

        {/* Content area */}
        {viewMode === "full" ? (
          <div className="rounded-lg border border-border p-6 max-h-[70vh] overflow-y-auto">
            <div className="prose">
              <ReactMarkdown>
                {source.raw_content || (source.file_path ? "*(Original file stored in MinIO)*" : "*No content*")}
              </ReactMarkdown>
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
                    <ReactMarkdown>{chunks[selectedChunk].content}</ReactMarkdown>
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
