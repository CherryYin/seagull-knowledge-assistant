import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Newspaper, Check, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { notesApi, type Note } from "@/lib/api";

export function DigestPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["digest"],
    queryFn: () => notesApi.list({ note_type: "digest", status: "pending_review", limit: 100 }),
  });

  const acceptMutation = useMutation({
    mutationFn: (id: string) =>
      notesApi.update(id, { note_type: "concept", status: "seed" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["digest"] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => notesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["digest"] });
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Digest</h1>
            <p className="text-sm text-muted-foreground">
              Review RSS topic summaries. Save the ones worth keeping.
            </p>
          </div>
          {items.length > 0 && (
            <Badge variant="secondary">{items.length} pending</Badge>
          )}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {!isLoading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Newspaper className="h-12 w-12 mb-3 opacity-30" />
            <p>No pending digests. New summaries appear after RSS feeds are fetched.</p>
          </div>
        )}

        <div className="space-y-2">
          {items.map((note) => (
            <DigestRow
              key={note.id}
              note={note}
              onView={() => navigate(`/notes/${encodeURIComponent(note.id)}`)}
              onAccept={() => acceptMutation.mutate(note.id)}
              onDismiss={() => dismissMutation.mutate(note.id)}
              accepting={acceptMutation.isPending && acceptMutation.variables === note.id}
              dismissing={dismissMutation.isPending && dismissMutation.variables === note.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DigestRow({
  note,
  onView,
  onAccept,
  onDismiss,
  accepting,
  dismissing,
}: {
  note: Note;
  onView: () => void;
  onAccept: () => void;
  onDismiss: () => void;
  accepting: boolean;
  dismissing: boolean;
}) {
  const preview = (note.content || "")
    .replace(/^#+\s.*/gm, "")
    .replace(/\n{2,}/g, " ")
    .trim()
    .slice(0, 200);

  const sourceCount = note.source_ids?.length ?? 0;

  return (
    <div className="group rounded-lg border border-border p-4 hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onView}>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium truncate">{note.title}</h3>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{preview}</p>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-[10px] text-muted-foreground">
              {new Date(note.created_at).toLocaleDateString()}
            </span>
            {sourceCount > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {sourceCount} sources
              </span>
            )}
            {note.domains?.map((d) => (
              <Badge key={d} variant="outline" className="text-[10px] px-1.5 py-0">
                {d}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
            onClick={onView}
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950"
            onClick={onAccept}
            disabled={accepting || dismissing}
          >
            <Check className="h-3 w-3" />
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={onDismiss}
            disabled={accepting || dismissing}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
