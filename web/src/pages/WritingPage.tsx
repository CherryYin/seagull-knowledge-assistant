import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PenLine, ExternalLink, FileDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { notesApi, type Note } from "@/lib/api";

export function WritingPage() {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["writing"],
    queryFn: () => notesApi.list({ tag: "from-document", limit: 100 }),
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Writing</h1>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {data && data.total === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <PenLine className="h-12 w-12 mb-3 opacity-30" />
            <p>No documents yet. Generate one in Chat to get started.</p>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {data?.items.map((note) => (
            <WritingCard
              key={note.id}
              note={note}
              onClick={() => navigate(`/notes/${encodeURIComponent(note.id)}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function WritingCard({ note, onClick }: { note: Note; onClick: () => void }) {
  const sourceId = note.source_ids?.[0];

  return (
    <Card className="cursor-pointer hover:border-primary/40 transition-colors" onClick={onClick}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="note">{note.note_type}</Badge>
          {note.category_name && (
            <Badge variant="outline">{note.category_name}</Badge>
          )}
        </div>
        <CardTitle className="text-sm">{note.title}</CardTitle>
        {note.abstract && (
          <CardDescription className="line-clamp-2">{note.abstract}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">
            {new Date(note.created_at).toLocaleDateString()} · {note.word_count ?? 0} words
          </p>
          <div className="flex items-center gap-1">
            <button
              className="flex items-center gap-1 text-[10px] text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                notesApi.exportPdf(note.id, note.title);
              }}
            >
              <FileDown className="h-3 w-3" />
              PDF
            </button>
            {sourceId && (
              <button
                className="flex items-center gap-1 text-[10px] text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = `/sources/${encodeURIComponent(sourceId)}`;
                }}
              >
                <ExternalLink className="h-3 w-3" />
                Source
              </button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
