import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Braces, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  getMindMapVersionConflict,
  mindMapsApi,
  type MindMapNodeRead,
  type MindMapOutlineApplyResult,
  type MindMapVersionConflict,
} from "@/lib/api/mind-maps";
import { buildMindMapOutline } from "@/lib/mind-map-outline";

interface MindMapOutlinePanelProps {
  mapId: string;
  currentVersion: number;
  nodes: MindMapNodeRead[];
  onChanged: () => Promise<unknown>;
  onConflict: (conflict: MindMapVersionConflict) => Promise<unknown>;
}

export function MindMapOutlinePanel({ mapId, currentVersion, nodes, onChanged, onConflict }: MindMapOutlinePanelProps) {
  const generatedOutline = buildMindMapOutline(nodes);
  const [outline, setOutline] = useState(generatedOutline);
  const [loadedVersion, setLoadedVersion] = useState(currentVersion);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [result, setResult] = useState<MindMapOutlineApplyResult | null>(null);

  useEffect(() => {
    if (loadedVersion === currentVersion) return;
    setOutline(generatedOutline);
    setLoadedVersion(currentVersion);
  }, [currentVersion, generatedOutline, loadedVersion]);

  const applyMutation = useMutation({
    mutationFn: () => mindMapsApi.applyOutline(mapId, {
      base_version: currentVersion,
      mode,
      outline,
      confirm_replace: mode === "replace" && replaceConfirmed,
      updated_by: "human",
    }),
    onSuccess: async (nextResult) => {
      setResult(nextResult);
      setReplaceConfirmed(false);
      await onChanged();
    },
    onError: async (error) => {
      const conflict = getMindMapVersionConflict(error);
      if (!conflict) return;
      setResult(null);
      setReplaceConfirmed(false);
      await onConflict(conflict);
    },
  });
  const canApply = outline.trim().length > 0 && (mode === "merge" || replaceConfirmed);

  return (
    <Card data-testid="mind-map-outline-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Braces className="h-4 w-4" />Outline editor</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg bg-muted p-1" role="group" aria-label="Outline apply mode">
            <Button type="button" size="sm" variant={mode === "merge" ? "default" : "ghost"} onClick={() => { setMode("merge"); setReplaceConfirmed(false); }}>Merge</Button>
            <Button type="button" size="sm" variant={mode === "replace" ? "destructive" : "ghost"} onClick={() => setMode("replace")}>Replace</Button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => { setOutline(generatedOutline); setResult(null); }}
          >
            <RefreshCw className="h-4 w-4" />Reload current tree
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Stable IDs update existing nodes. New lines without an ID create nodes. Merge preserves omitted branches.
        </p>
        <Textarea
          aria-label="Mind Map outline"
          className="min-h-[280px] resize-y font-mono text-xs leading-5"
          spellCheck={false}
          value={outline}
          onChange={(event) => { setOutline(event.target.value); setResult(null); }}
        />
        {mode === "replace" && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">Replace rebuilds every non-root node.</p>
            <p className="mt-2 text-muted-foreground">The root identity and revision history remain, but omitted branches and their references are deleted.</p>
            <label className="mt-3 flex cursor-pointer items-start gap-2">
              <input
                aria-label="Confirm replace outline"
                className="mt-1"
                type="checkbox"
                checked={replaceConfirmed}
                onChange={(event) => setReplaceConfirmed(event.target.checked)}
              />
              <span>I understand this replaces all non-root nodes.</span>
            </label>
          </div>
        )}
        {result && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm" data-testid="mind-map-outline-result">
            <p className="font-medium">{result.mode === "merge" ? "Merge" : "Replace"} applied as v{result.current_version}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="outline">{result.created_count} created</Badge>
              <Badge variant="outline">{result.updated_count} updated</Badge>
              <Badge variant="outline">{result.moved_count} moved</Badge>
              <Badge variant="outline">{result.deleted_count} deleted</Badge>
            </div>
          </div>
        )}
        {applyMutation.isError && !getMindMapVersionConflict(applyMutation.error) && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{applyMutation.error.message}</p>
        )}
        <div className="flex justify-end">
          <Button type="button" variant={mode === "replace" ? "destructive" : "default"} disabled={!canApply || applyMutation.isPending} onClick={() => applyMutation.mutate()}>
            {applyMutation.isPending ? "Applying…" : mode === "replace" ? "Replace tree" : "Apply merge"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
