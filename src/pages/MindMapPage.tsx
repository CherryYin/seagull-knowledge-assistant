import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Focus, Move, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MindMapCanvas,
  MindMapNodeMutationDialog,
  type MindMapCanvasMetrics,
  type MindMapCanvasNode,
  type MindMapNodeMutationCommand,
  type MindMapNodeMutationMode,
} from "@/components/mind-map";
import { StateMessage } from "@/components/StateMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getMindMapVersionConflict,
  mindMapsApi,
  type MindMapReferenceRead,
} from "@/lib/api/mind-maps";
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
  const [initializedMapId, setInitializedMapId] = useState<string | null>(null);
  const [mutationMode, setMutationMode] = useState<MindMapNodeMutationMode | null>(null);
  const [versionConflictMessage, setVersionConflictMessage] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MindMapCanvasMetrics>({
    visibleCount: 0,
    maxDepth: 0,
    layoutDurationMs: 0,
  });

  useEffect(() => {
    if (!treeQuery.data || treeQuery.data.map.id === initializedMapId) return;
    setLayoutMode(treeQuery.data.map.layout_mode);
    setCollapsedIds(new Set(treeQuery.data.nodes.filter((node) => node.collapsed).map((node) => node.id)));
    setFocusId(null);
    setSelectedId(null);
    setInitializedMapId(treeQuery.data.map.id);
  }, [initializedMapId, treeQuery.data]);

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
  const subtreeIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const children = new Map<string, string[]>();
    for (const node of treeQuery.data?.nodes ?? []) {
      if (!node.parent_id) continue;
      const items = children.get(node.parent_id) ?? [];
      items.push(node.id);
      children.set(node.parent_id, items);
    }
    const result = new Set<string>();
    const pending = [selectedId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      pending.push(...(children.get(current) ?? []));
    }
    return result;
  }, [selectedId, treeQuery.data?.nodes]);
  const parentCandidates = useMemo(
    () => (treeQuery.data?.nodes ?? []).filter((node) => !subtreeIds.has(node.id)),
    [subtreeIds, treeQuery.data?.nodes],
  );
  const subtreeReferenceCount = useMemo(
    () => (treeQuery.data?.references ?? []).filter((reference) => subtreeIds.has(reference.node_id)).length,
    [subtreeIds, treeQuery.data?.references],
  );
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
  const nodeMutation = useMutation({
    mutationFn: async (command: MindMapNodeMutationCommand) => {
      if (!mapId || !treeQuery.data) throw new Error("Mind Map is not loaded");
      const baseVersion = treeQuery.data.map.version;
      if (command.type === "add") {
        return mindMapsApi.addNode(mapId, {
          base_version: baseVersion,
          parent_id: command.parentId,
          content: command.content,
          note: command.note,
          node_kind: command.nodeKind,
          updated_by: "human",
        });
      }
      if (command.type === "edit") {
        return mindMapsApi.updateNode(mapId, command.nodeId, {
          base_version: baseVersion,
          content: command.content,
          note: command.note,
          node_kind: command.nodeKind,
          updated_by: "human",
        });
      }
      if (command.type === "move") {
        return mindMapsApi.moveNode(mapId, command.nodeId, {
          base_version: baseVersion,
          parent_id: command.parentId,
          position: command.position,
          updated_by: "human",
        });
      }
      return mindMapsApi.deleteNode(mapId, command.nodeId, {
        base_version: baseVersion,
        delete_subtree: true,
        updated_by: "human",
      });
    },
    onSuccess: async (result, command) => {
      setMutationMode(null);
      setVersionConflictMessage(null);
      if (command.type === "delete") {
        setSelectedId(null);
        if (focusId && result.deleted_node_ids.includes(focusId)) setFocusId(null);
        setCollapsedIds((current) => new Set([...current].filter((nodeId) => !result.deleted_node_ids.includes(nodeId))));
      } else if (result.node?.id) {
        setSelectedId(result.node.id);
      }
      await treeQuery.refetch();
    },
    onError: async (error) => {
      const conflict = getMindMapVersionConflict(error);
      if (!conflict) return;
      setMutationMode(null);
      setVersionConflictMessage(
        `This Mind Map changed from version ${conflict.expected_version} to ${conflict.current_version}. The latest tree was loaded; review it before trying the operation again.`,
      );
      await treeQuery.refetch();
    },
  });
  const openMutation = (mode: MindMapNodeMutationMode) => {
    nodeMutation.reset();
    setMutationMode(mode);
  };

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

      {versionConflictMessage && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm" data-testid="mind-map-version-conflict">
          <div className="flex-1"><p className="font-medium">Mind Map refreshed after a version conflict</p><p className="mt-1 text-muted-foreground">{versionConflictMessage}</p></div>
          <Button type="button" variant="ghost" size="icon" aria-label="Dismiss version conflict" onClick={() => setVersionConflictMessage(null)}><X className="h-4 w-4" /></Button>
        </div>
      )}

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
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => openMutation("add")}><Plus className="h-4 w-4" />Add child</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => openMutation("edit")}><Pencil className="h-4 w-4" />Edit</Button>
                    <Button type="button" variant="outline" size="sm" disabled={selectedNode.id === treeQuery.data.root_id || parentCandidates.length === 0} onClick={() => openMutation("move")}><Move className="h-4 w-4" />Move</Button>
                    <Button type="button" variant="destructive" size="sm" disabled={selectedNode.id === treeQuery.data.root_id} onClick={() => openMutation("delete")}><Trash2 className="h-4 w-4" />Delete</Button>
                  </div>
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
      <MindMapNodeMutationDialog
        mode={mutationMode}
        selectedNode={selectedNode}
        parentCandidates={parentCandidates}
        subtreeNodeCount={subtreeIds.size}
        subtreeReferenceCount={subtreeReferenceCount}
        pending={nodeMutation.isPending}
        error={nodeMutation.isError && !getMindMapVersionConflict(nodeMutation.error) ? nodeMutation.error.message : null}
        onClose={() => { if (!nodeMutation.isPending) setMutationMode(null); }}
        onSubmit={(command) => nodeMutation.mutate(command)}
      />
    </div>
  );
}
