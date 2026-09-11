import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Focus, Move, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  MindMapCanvas,
  MindMapNodeMutationDialog,
  MindMapOutlinePanel,
  MindMapRevisionPanel,
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
import type { Viewport } from "@xyflow/react";
import { useReturnNavigation } from "@/hooks/useReturnNavigation";

export function MindMapPage() {
  const { mapId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const treeQuery = useQuery({
    queryKey: ["mind-map-tree", mapId],
    queryFn: () => mindMapsApi.getTree(mapId!),
    enabled: Boolean(mapId),
  });
  const [layoutMode, setLayoutMode] = useState<MindMapLayoutMode>("balanced");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
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
    const nodeIds = new Set(treeQuery.data.nodes.map((node) => node.id));
    const requestedSelectedId = new URLSearchParams(location.search).get("selected");
    let storedState: {
      layoutMode?: MindMapLayoutMode;
      collapsedIds?: string[];
      focusId?: string | null;
      selectedId?: string | null;
      viewport?: Viewport | null;
    } | null = null;
    try {
      const rawState = sessionStorage.getItem(`mind-map-view:${treeQuery.data.map.id}`);
      storedState = rawState ? JSON.parse(rawState) : null;
    } catch {
      storedState = null;
    }
    const storedLayoutMode = storedState?.layoutMode;
    setLayoutMode(storedLayoutMode === "balanced" || storedLayoutMode === "right"
      ? storedLayoutMode
      : treeQuery.data.map.layout_mode);
    setCollapsedIds(storedState?.collapsedIds
      ? new Set(storedState.collapsedIds.filter((nodeId) => nodeIds.has(nodeId)))
      : new Set(treeQuery.data.nodes.filter((node) => node.collapsed).map((node) => node.id)));
    setFocusId(storedState?.focusId && nodeIds.has(storedState.focusId) ? storedState.focusId : null);
    setSelectedId(
      requestedSelectedId && nodeIds.has(requestedSelectedId)
        ? requestedSelectedId
        : storedState?.selectedId && nodeIds.has(storedState.selectedId)
          ? storedState.selectedId
          : null,
    );
    const storedViewport = storedState?.viewport;
    setViewport(storedViewport && Number.isFinite(storedViewport.x) && Number.isFinite(storedViewport.y) && Number.isFinite(storedViewport.zoom)
      ? storedViewport
      : null);
    setInitializedMapId(treeQuery.data.map.id);
  }, [initializedMapId, location.search, treeQuery.data]);

  useEffect(() => {
    if (!mapId || initializedMapId !== mapId) return;
    sessionStorage.setItem(`mind-map-view:${mapId}`, JSON.stringify({
      layoutMode,
      collapsedIds: [...collapsedIds],
      focusId,
      selectedId,
      viewport,
    }));
  }, [collapsedIds, focusId, initializedMapId, layoutMode, mapId, selectedId, viewport]);

  const ownerPath = treeQuery.data?.map.owner_type === "source"
    ? `/sources/${encodeURIComponent(treeQuery.data.map.owner_id)}`
    : treeQuery.data?.map.owner_type === "asset"
      ? `/assets/${encodeURIComponent(treeQuery.data.map.owner_id)}`
      : "/";
  const backTo = locationState?.backTo || ownerPath;
  const backLabel = locationState?.backLabel || `Back to ${treeQuery.data?.map.owner_type || "owner"}`;
  const returnToPrevious = useReturnNavigation(backTo, false);

  const updateSelectedId = (nextSelectedId: string | null) => {
    setSelectedId(nextSelectedId);
    const next = new URLSearchParams(location.search);
    if (nextSelectedId) next.set("selected", nextSelectedId);
    else next.delete("selected");
    navigate(
      { pathname: location.pathname, search: next.toString() ? `?${next.toString()}` : "" },
      { replace: true, state: location.state },
    );
  };

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
  const refreshMindMap = async () => {
    await Promise.all([
      treeQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ["mind-map-revisions", mapId] }),
    ]);
  };
  const handleVersionConflict = async (conflict: ReturnType<typeof getMindMapVersionConflict> & {}) => {
    setVersionConflictMessage(
      `This Mind Map changed from version ${conflict.expected_version} to ${conflict.current_version}. The latest tree was loaded; review it before trying the operation again.`,
    );
    await refreshMindMap();
  };
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
        updateSelectedId(null);
        if (focusId && result.deleted_node_ids.includes(focusId)) setFocusId(null);
        setCollapsedIds((current) => new Set([...current].filter((nodeId) => !result.deleted_node_ids.includes(nodeId))));
      } else if (result.node?.id) {
        updateSelectedId(result.node.id);
      }
      await refreshMindMap();
    },
    onError: async (error) => {
      const conflict = getMindMapVersionConflict(error);
      if (!conflict) return;
      setMutationMode(null);
      await handleVersionConflict(conflict);
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
  const openSourceChunk = (reference: MindMapReferenceRead) => {
    if (map.owner_type !== "source" || reference.ref_type !== "source_chunk" || !selectedNode) return;
    const query = new URLSearchParams({ view: "slices", chunk_id: reference.ref_id });
    const page = reference.fragment_selector?.page;
    const quote = reference.fragment_selector?.quote;
    if (typeof page === "number" || typeof page === "string") query.set("page", String(page));
    if (typeof quote === "string" && quote.trim()) query.set("quote", quote.trim());
    navigate(`/sources/${encodeURIComponent(map.owner_id)}?${query}`, {
      state: {
        backTo: `/mind-maps/${encodeURIComponent(map.id)}?selected=${encodeURIComponent(selectedNode.id)}`,
        backLabel: "Back to Mind Map",
      },
    });
  };
  const resetView = () => {
    setCollapsedIds(new Set());
    setFocusId(null);
    updateSelectedId(null);
    setViewport(null);
  };

  return (
    <div className="space-y-6" data-testid="mind-map-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button type="button" variant="ghost" size="sm" className="mb-2 -ml-3" onClick={returnToPrevious}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{map.title}</h1>
            <Badge variant="secondary" data-testid="mind-map-current-version">v{map.version}</Badge>
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
              <button type="button" className="hover:text-primary" onClick={() => updateSelectedId(node.id)}>{node.content}</button>
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
              onSelectedIdChange={updateSelectedId}
              onCollapsedIdsChange={setCollapsedIds}
              onMetricsChange={setMetrics}
              initialViewport={viewport}
              onViewportChange={setViewport}
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
                        <div key={reference.id} className="rounded-lg border p-3 text-xs" data-testid={`mind-map-reference-${reference.id}`}>
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="secondary">
                              {reference.ref_type === "source_chunk" ? `Chunk #${reference.ref_id}` : reference.ref_type}
                            </Badge>
                            <span className="text-muted-foreground">{reference.relation}</span>
                          </div>
                          {reference.ref_type !== "source_chunk" && (
                            <p className="mt-2 break-all text-muted-foreground">{reference.ref_id}</p>
                          )}
                          {(typeof reference.fragment_selector?.page === "number" || typeof reference.fragment_selector?.page === "string") && (
                            <p className="mt-2 font-medium">Page {String(reference.fragment_selector.page)}</p>
                          )}
                          {typeof reference.fragment_selector?.quote === "string" && reference.fragment_selector.quote.trim() && (
                            <blockquote className="mt-2 line-clamp-4 border-l-2 pl-2 text-muted-foreground">
                              {reference.fragment_selector.quote}
                            </blockquote>
                          )}
                          {map.owner_type === "source" && reference.ref_type === "source_chunk" && (
                            <Button type="button" variant="outline" size="sm" className="mt-3 w-full" onClick={() => openSourceChunk(reference)}>
                              <ExternalLink className="h-3.5 w-3.5" />Open Source Chunk
                            </Button>
                          )}
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
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <MindMapOutlinePanel
          mapId={mapId}
          currentVersion={map.version}
          nodes={treeQuery.data.nodes}
          onChanged={refreshMindMap}
          onConflict={handleVersionConflict}
        />
        <MindMapRevisionPanel
          mapId={mapId}
          currentVersion={map.version}
          onChanged={refreshMindMap}
          onConflict={handleVersionConflict}
        />
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
