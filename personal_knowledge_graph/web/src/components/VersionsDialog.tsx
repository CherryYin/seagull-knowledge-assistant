import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NoteContentRenderer } from "@/components/NoteContentRenderer";
import { notesApi, type NoteVersion } from "@/lib/api";

interface VersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteId: string;
  onRestored?: () => void;
}

export function VersionsDialog({ open, onOpenChange, noteId, onRestored }: VersionsDialogProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(0);

  const { data: versions, isLoading } = useQuery({
    queryKey: ["note-versions", noteId],
    queryFn: () => notesApi.versions(noteId),
    enabled: open,
  });

  const restoreMutation = useMutation({
    mutationFn: (versionIdx: number) => notesApi.restoreVersion(noteId, versionIdx),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["note", noteId] });
      queryClient.invalidateQueries({ queryKey: ["note-versions", noteId] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      onRestored?.();
      onOpenChange(false);
    },
  });

  const list: NoteVersion[] = versions ?? [];
  const current = list[selected];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Version History
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 gap-3 overflow-hidden">
          <div className="w-56 shrink-0 overflow-y-auto rounded-md border border-border">
            {isLoading && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
            {!isLoading && list.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">No saved versions yet. Versions are captured when you edit the content.</p>
            )}
            {list.map((v, idx) => (
              <button
                key={idx}
                onClick={() => setSelected(idx)}
                className={`w-full border-b border-border/50 px-3 py-2 text-left transition-colors cursor-pointer ${
                  selected === idx ? "bg-primary/10 border-l-2 border-l-primary" : "hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">v{idx + 1}</span>
                  <span className="text-[10px] text-muted-foreground">{v.content.length} chars</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(v.created_at).toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground line-clamp-1">{v.title || "(untitled)"}</p>
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 overflow-y-auto rounded-md border border-border p-4">
            {current ? (
              <div className="prose prose-sm max-w-none">
                <NoteContentRenderer content={current.content} mode="markdown" noteId={noteId} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Select a version to preview.</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between pt-3">
          <span className="text-xs text-muted-foreground">
            {list.length} version{list.length === 1 ? "" : "s"} stored
          </span>
          <Button
            size="sm"
            onClick={() => restoreMutation.mutate(selected)}
            disabled={!current || restoreMutation.isPending}
          >
            <RotateCcw className="h-3.5 w-3.5" /> {restoreMutation.isPending ? "Restoring…" : "Restore this version"}
          </Button>
        </div>
        {restoreMutation.isError && (
          <p className="text-xs text-destructive">
            {restoreMutation.error instanceof Error ? restoreMutation.error.message : "Restore failed"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
