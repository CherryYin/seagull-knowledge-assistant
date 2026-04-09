import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { sourcesApi } from "@/lib/api";

export function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: source, isLoading, error } = useQuery({
    queryKey: ["source", id],
    queryFn: () => sourcesApi.get(id!),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading...</div>;
  if (error || !source) return <div className="p-8 text-destructive">Source not found.</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate("/sources")} className="mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Sources
        </Button>

        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="source">{source.source_type}</Badge>
          </div>
          <h1 className="text-2xl font-bold">{source.title}</h1>
          {source.url && (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
            >
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

        <div className="rounded-lg border border-border p-6">
          <div className="prose">
            <ReactMarkdown>
              {source.raw_content || (source.file_path ? "*(Original file stored in MinIO)*" : "*No content*")}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
