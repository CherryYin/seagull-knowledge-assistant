import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Focus, RotateCcw } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MindMapCanvas,
  type MindMapCanvasMetrics,
  type MindMapCanvasNode,
} from "@/components/mind-map";
import { StateMessage } from "@/components/StateMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { mindMapsApi, type MindMapReferenceRead } from "@/lib/api/mind-maps";
import type { MindMapLayoutMode } from "@/lib/mind-map-layout";

export function MindMapPage() {
  const { mapId } = useParams();
  const navigate = useNavigate();
  const treeQuery = useQuery({
    queryKey: ["mind-map-tree", mapId],
    queryFn: () => mindMapsApi.getTree(mapId!),
    enabled: Boolean(mapId),
  });
  const [layoutMode, setLayoutMode] = useState<MindMapLayoutMode>("balanced");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MindMapCanvasMetrics>({
    visibleCount: 0,
    maxDepth: 0,
    layoutDurationMs: 0,
  });

  useEffect(() => {
    if (!treeQuery.data) return;
    setLayoutMode(treeQuery.data.map.layout_mode);
    setCollapsedIds(new Set(treeQuery.data.nodes.filter((node) => node.collapsed).map((node) => node.id)));
    setFocusId(null);
    setSelectedId(null);
  }, [treeQuery.data]);

  const referencesByNode = useMemo(() => {
    const result = new Map<string, MindMapReferenceRead[]>();
    for (const reference of treeQuery.data?.references ?? []) {
      const items = result.get(reference.node_id) ?? [];
      items.push(reference);
      result.set(reference.node_id, items);
    }
    return result;
  }, [treeQuery.data?.references]);
  const canvasNodes = useMemo<MindMapCanvasNode[]>(() => (treeQuery.data?.nodes ?? []).map((node) => ({
    id: node.id,
    parentId: node.parent_id,
    label: node.content,
    displayId: node.display_id,
    kind: node.node_kind,
    referenceCount: referencesByNode.get(node.id)?.length ?? 0,
  })), [referencesByNode, treeQuery.data?.nodes]);
  const nodeById = useMemo(
    () => new Map((treeQuery.data?.nodes ?? []).map((node) => [node.id, node])),
    [treeQuery.data?.nodes],
  );
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const selectedReferences = selectedId ? referencesByNode.get(selectedId) ?? [] : [];
  const selectedHasChildren = selectedId
    ? (treeQuery.data?.nodes ?? []).some((node) => node.parent_id === selectedId)
    : false;
  const breadcrumbNode = (focusId && nodeById.get(focusId)) || selectedNode;
  const breadcrumbs = useMemo(() => {
    if (!breadcrumbNode) return [];
    const items = [];
    const visited = new Set<string>();
    let current: typeof breadcrumbNode | undefined = breadcrumbNode;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      items.unshift(current);
      current = current.parent_id ? nodeById.get(current.parent_id) : undefined;
    }
    return items;
  }, [breadcrumbNode, nodeById]);

  if (!mapId) return <StateMessage tone="error" title="Mind Map ID is missing" />;
  if (treeQuery.isLoading) return <StateMessage title="Loading Mind Map" description="Reading the current tree and references…" />;
  if (treeQuery.isError || !treeQuery.data) {
    return (
      <StateMessage
        tone="error"
        title="Could not load Mind Map"
        description={treeQuery.error instanceof Error ? treeQuery.error.message : "The Mind Map is unavailable."}
        actionLabel="Try again"
        onAction={() => treeQuery.refetch()}
      />
    );
  }

  const { map } = treeQuery.data;
  const ownerPath = map.owner_type === "source"
    ? `/sources/${encodeURIComponent(map.owner_id)}`
    : `/assets/${encodeURIComponent(map.owner_id)}`;
  const resetView = () => {
    setCollapsedIds(new Set());
    setFocusId(null);
    setSelectedId(null);
  };

  return (
    <div className="space-y-6" data-testid="mind-map-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button type="button" variant="ghost" size="sm" className="mb-2 -ml-3" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{map.title}</h1>
            <Badge variant="secondary">v{map.version}</Badge>
            <Badge variant="outline">{map.generation_status}</Badge>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{map.purpose.replace(/_/g, " ")}</span>
            <span>·</span>
            <Link className="text-primary hover:underline" to={ownerPath}>Open {map.owner_type}</Link>
            <span>·</span>
            <span data-testid="mind-map-visible-summary">{metrics.visibleCount} visible / {treeQuery.data.nodes.length} total</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={layoutMode === "balanced" ? "default" : "outline"} size="sm" onClick={() => setLayoutMode("balanced")}>Balanced</Button>
          <Button type="button" variant={layoutMode === "right" ? "default" : "outline"} size="sm" onClick={() => setLayoutMode("right")}>Right</Button>
          <Button type="button" variant="outline" size="sm" onClick={resetView}><RotateCcw className="h-4 w-4" />Reset view</Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Path</span>
          {breadcrumbs.length === 0 ? (
            <span className="text-sm text-muted-foreground">Select a node to inspect its path.</span>
          ) : breadcrumbs.map((node, index) => (
            <span key={node.id} className="text-sm">
              {index > 0 && <span className="mr-2 text-muted-foreground">/</span>}
              <button type="button" className="hover:text-primary" onClick={() => setSelectedId(node.id)}>{node.content}</button>
            </span>
          ))}
          <span className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selectedNode || !selectedHasChildren}
              onClick={() => {
                if (!selectedId) return;
                const next = new Set(collapsedIds);
                if (next.has(selectedId)) next.delete(selectedId);
                else next.add(selectedId);
                setCollapsedIds(next);
              }}
            >
              {selectedId && collapsedIds.has(selectedId) ? "Expand selected" : "Collapse selected"}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!selectedNode} onClick={() => setFocusId(selectedId)}>
              <Focus className="h-4 w-4" />Focus selected
            </Button>
          </span>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <MindMapCanvas
              nodes={canvasNodes}
              layoutMode={layoutMode}
              collapsedIds={collapsedIds}
              focusId={focusId}
              selectedId={selectedId}
              onSelectedIdChange={setSelectedId}
              onCollapsedIdsChange={setCollapsedIds}
              onMetricsChange={setMetrics}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Node details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {!selectedNode ? (
              <p className="text-sm text-muted-foreground">Select a node to inspect its note and formal references.</p>
            ) : (
              <>
                <div>
                  <div className="flex flex-wrap gap-2"><Badge>#{selectedNode.display_id}</Badge><Badge variant="outline">{selectedNode.node_kind}</Badge><Badge variant="outline">{selectedNode.updated_by}</Badge></div>
                  <h2 className="mt-3 font-medium">{selectedNode.content}</h2>
                  {selectedNode.note && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{selectedNode.note}</p>}
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">References</p>
                  {selectedReferences.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No formal references.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {selectedReferences.map((reference) => (
                        <div key={reference.id} className="rounded-lg border p-2.5 text-xs">
                          <div className="flex items-center justify-between gap-2"><Badge variant="secondary">{reference.ref_type}</Badge><span>{reference.relation}</span></div>
                          <p className="mt-2 break-all text-muted-foreground">{reference.ref_id}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
