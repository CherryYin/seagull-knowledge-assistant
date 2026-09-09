import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Eye, History, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  getMindMapVersionConflict,
  mindMapsApi,
  type MindMapRevisionRead,
  type MindMapVersionConflict,
} from "@/lib/api/mind-maps";

interface MindMapRevisionPanelProps {
  mapId: string;
  currentVersion: number;
  onChanged: () => Promise<unknown>;
  onConflict: (conflict: MindMapVersionConflict) => Promise<unknown>;
}

function formatRevisionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function MindMapRevisionPanel({ mapId, currentVersion, onChanged, onConflict }: MindMapRevisionPanelProps) {
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<MindMapRevisionRead | null>(null);
  const revisionsQuery = useQuery({
    queryKey: ["mind-map-revisions", mapId],
    queryFn: () => mindMapsApi.listRevisions(mapId, 20, 0),
  });
  const previewQuery = useQuery({
    queryKey: ["mind-map-revision", mapId, previewVersion],
    queryFn: () => mindMapsApi.getRevision(mapId, previewVersion!),
    enabled: previewVersion !== null,
  });
  const restoreMutation = useMutation({
    mutationFn: (version: number) => mindMapsApi.restoreRevision(mapId, version, {
      base_version: currentVersion,
      confirm: true,
    }),
    onSuccess: async () => {
      setRestoreTarget(null);
      await Promise.all([onChanged(), revisionsQuery.refetch()]);
    },
    onError: async (error) => {
      const conflict = getMindMapVersionConflict(error);
      if (!conflict) return;
      setRestoreTarget(null);
      await Promise.all([onConflict(conflict), revisionsQuery.refetch()]);
    },
  });
  const revisions = revisionsQuery.data?.items ?? [];

  return (
    <Card data-testid="mind-map-revision-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" />Revision history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {revisionsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading revisions…</p>}
        {revisionsQuery.isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="text-destructive">Could not load revision history.</p>
            <Button className="mt-2" type="button" size="sm" variant="outline" onClick={() => revisionsQuery.refetch()}>Try again</Button>
          </div>
        )}
        {!revisionsQuery.isLoading && revisions.length === 0 && <p className="text-sm text-muted-foreground">No revisions have been recorded.</p>}
        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
          {revisions.map((revision) => {
            const historical = revision.version < currentVersion;
            return (
              <div key={revision.id} className="rounded-xl border p-3" data-testid={`mind-map-revision-${revision.version}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={revision.version === currentVersion ? "secondary" : "outline"}>v{revision.version}</Badge>
                      <span className="text-sm font-medium">{revision.action.replace(/_/g, " ")}</span>
                      <Badge variant="outline">{revision.actor_type}</Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{revision.summary}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatRevisionDate(revision.created_at)}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setPreviewVersion(revision.version)}>
                      <Eye className="h-4 w-4" />Preview
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={!historical} onClick={() => setRestoreTarget(revision)}>
                      <RotateCcw className="h-4 w-4" />Restore
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {restoreMutation.isError && !getMindMapVersionConflict(restoreMutation.error) && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{restoreMutation.error.message}</p>
        )}
      </CardContent>

      <Dialog open={previewVersion !== null} onOpenChange={(open) => { if (!open) setPreviewVersion(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Revision v{previewVersion} snapshot</DialogTitle></DialogHeader>
          {previewQuery.isLoading && <p className="text-sm text-muted-foreground">Loading snapshot…</p>}
          {previewQuery.isError && <p className="text-sm text-destructive">Could not load this revision.</p>}
          {previewQuery.data && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">{previewQuery.data.summary}</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Nodes</p><p className="mt-1 text-lg font-semibold">{previewQuery.data.snapshot.nodes.length}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">References</p><p className="mt-1 text-lg font-semibold">{previewQuery.data.snapshot.references.length}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Layout</p><p className="mt-1 font-medium">{previewQuery.data.snapshot.map.layout_mode}</p></div>
              </div>
              <div className="max-h-[320px] space-y-1 overflow-y-auto rounded-lg bg-muted/50 p-3">
                {previewQuery.data.snapshot.nodes
                  .slice()
                  .sort((left, right) => left.display_id - right.display_id)
                  .map((node) => <p key={node.id}><span className="text-muted-foreground">#{node.display_id}</span> {node.content}</p>)}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={restoreTarget !== null} onOpenChange={(open) => { if (!open && !restoreMutation.isPending) setRestoreTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Restore revision v{restoreTarget?.version}?</DialogTitle></DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="font-medium">Current version: v{currentVersion}</p>
              <p className="mt-2 text-muted-foreground">The v{restoreTarget?.version} snapshot becomes a new revision. Existing history remains available.</p>
            </div>
            <p className="text-muted-foreground">If another edit lands first, the restore stops and reloads the latest tree without retrying.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={restoreMutation.isPending} onClick={() => setRestoreTarget(null)}>Cancel</Button>
              <Button type="button" disabled={restoreMutation.isPending || !restoreTarget} onClick={() => restoreTarget && restoreMutation.mutate(restoreTarget.version)}>
                {restoreMutation.isPending ? "Restoring…" : "Restore as new version"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
