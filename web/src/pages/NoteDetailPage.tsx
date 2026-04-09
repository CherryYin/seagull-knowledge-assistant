import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { notesApi } from "@/lib/api";

export function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: note, isLoading, error } = useQuery({
    queryKey: ["note", id],
    queryFn: () => notesApi.get(id!),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading...</div>;
  if (error || !note) return <div className="p-8 text-destructive">Note not found.</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate("/notes")} className="mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Notes
        </Button>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Content */}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold mb-2">{note.title}</h1>
            {note.abstract && (
              <p className="text-muted-foreground text-sm mb-6 border-l-2 border-primary pl-3">
                {note.abstract}
              </p>
            )}
            {note.file_path && (
              <div className="mb-4">
                <Button asChild variant="outline" size="sm">
                  <a href={`/api/notes/${encodeURIComponent(note.id)}/file`} target="_blank" rel="noopener noreferrer">
                    <Download className="h-4 w-4" /> Open Stored File
                  </a>
                </Button>
              </div>
            )}
            <div className="prose">
              <ReactMarkdown>{note.content || "*No content*"}</ReactMarkdown>
            </div>
          </div>

          {/* Metadata sidebar */}
          <aside className="lg:w-64 shrink-0 space-y-4">
            <div className="rounded-lg border border-border p-4 space-y-3 text-sm">
              <div>
                <span className="text-muted-foreground text-xs">Type</span>
                <div className="mt-1"><Badge variant="note">{note.note_type}</Badge></div>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Status / Confidence</span>
                <div className="mt-1 flex gap-1">
                  <Badge variant="outline">{note.status}</Badge>
                  <Badge variant="outline">{note.confidence}</Badge>
                </div>
              </div>
              {note.project && (
                <div>
                  <span className="text-muted-foreground text-xs">Project</span>
                  <p className="mt-1">{note.project}</p>
                </div>
              )}
              {note.domains.length > 0 && (
                <div>
                  <span className="text-muted-foreground text-xs">Domains</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {note.domains.map((d) => (
                      <Badge key={d} variant="secondary">{d}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {note.tags.length > 0 && (
                <div>
                  <span className="text-muted-foreground text-xs">Tags</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {note.tags.map((t) => (
                      <Badge key={t} variant="secondary">#{t}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {note.source_ids.length > 0 && (
                <div>
                  <span className="text-muted-foreground text-xs">Source References</span>
                  <div className="mt-1 space-y-1">
                    {note.source_ids.map((sid) => (
                      <button
                        key={sid}
                        onClick={() => navigate(`/sources/${encodeURIComponent(sid)}`)}
                        className="block text-xs text-primary hover:underline cursor-pointer"
                      >
                        {sid}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="border-t border-border pt-3 text-xs text-muted-foreground space-y-1">
                <p>Created: {new Date(note.created_at).toLocaleString()}</p>
                <p>Updated: {new Date(note.updated_at).toLocaleString()}</p>
                <p>Words: {note.word_count ?? 0}</p>
                <p className="font-mono text-[10px] break-all">{note.id}</p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
