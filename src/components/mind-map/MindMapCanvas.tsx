import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MindMapTreeNode, type MindMapFlowNode } from "@/components/mind-map/MindMapTreeNode";
import { cn } from "@/lib/utils";
import {
  filterMindMapTree,
  layoutMindMapTree,
  type MindMapLayoutMode,
  type MindMapTreeNode as LayoutTreeNode,
} from "@/lib/mind-map-layout";

export interface MindMapCanvasNode extends LayoutTreeNode {
  displayId?: number;
  kind?: string;
  referenceCount?: number;
}

export interface MindMapCanvasMetrics {
  visibleCount: number;
  maxDepth: number;
  layoutDurationMs: number;
}

interface MindMapCanvasProps {
  nodes: MindMapCanvasNode[];
  layoutMode: MindMapLayoutMode;
  collapsedIds: ReadonlySet<string>;
  focusId: string | null;
  selectedId: string | null;
  onSelectedIdChange: (nodeId: string | null) => void;
  onCollapsedIdsChange: (collapsedIds: Set<string>) => void;
  onMetricsChange?: (metrics: MindMapCanvasMetrics) => void;
  className?: string;
  testId?: string;
  showMiniMap?: boolean;
}

const nodeTypes: NodeTypes = { mindMapTreeNode: MindMapTreeNode };

export function MindMapCanvas({
  nodes,
  layoutMode,
  collapsedIds,
  focusId,
  selectedId,
  onSelectedIdChange,
  onCollapsedIdsChange,
  onMetricsChange,
  className,
  testId = "mind-map-canvas",
  showMiniMap = true,
}: MindMapCanvasProps) {
  const childrenByParent = useMemo(() => {
    const result = new Map<string, number>();
    for (const node of nodes) {
      if (node.parentId) result.set(node.parentId, (result.get(node.parentId) ?? 0) + 1);
    }
    return result;
  }, [nodes]);
  const measurement = useMemo(() => {
    try {
      const visibleTree = filterMindMapTree(nodes, collapsedIds, focusId);
      const startedAt = performance.now();
      const layout = layoutMindMapTree(visibleTree, layoutMode);
      return { layout, durationMs: performance.now() - startedAt, error: null };
    } catch (error) {
      return {
        layout: layoutMindMapTree([], layoutMode),
        durationMs: 0,
        error: error instanceof Error ? error.message : "Could not render Mind Map",
      };
    }
  }, [collapsedIds, focusId, layoutMode, nodes]);
  const toggleCollapse = useCallback((nodeId: string) => {
    const next = new Set(collapsedIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    onCollapsedIdsChange(next);
  }, [collapsedIds, onCollapsedIdsChange]);
  const flowNodes = useMemo<MindMapFlowNode[]>(() => measurement.layout.nodes.map((node) => ({
    id: node.id,
    type: "mindMapTreeNode",
    position: node.position,
    draggable: false,
    selectable: true,
    style: { width: node.width, height: node.height },
    data: {
      label: node.label,
      depth: node.depth,
      side: node.side,
      displayId: node.displayId,
      kind: node.kind,
      referenceCount: node.referenceCount ?? 0,
      hasChildren: (childrenByParent.get(node.id) ?? 0) > 0,
      collapsed: collapsedIds.has(node.id),
      selected: selectedId === node.id,
      onToggleCollapse: toggleCollapse,
    },
  })), [childrenByParent, collapsedIds, measurement.layout.nodes, selectedId, toggleCollapse]);
  const sideByNodeId = useMemo(
    () => new Map(measurement.layout.nodes.map((node) => [node.id, node.side])),
    [measurement.layout.nodes],
  );
  const flowEdges = useMemo<Edge[]>(() => measurement.layout.edges.map((edge) => {
    const side = sideByNodeId.get(edge.target) ?? 1;
    return {
      ...edge,
      type: "smoothstep",
      sourceHandle: side === -1 ? "source-left" : "source-right",
      targetHandle: side === -1 ? "target-right" : "target-left",
      style: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.3 },
    };
  }), [measurement.layout.edges, sideByNodeId]);
  const viewKey = `${layoutMode}:${focusId ?? "root"}:${[...collapsedIds].sort().join(",")}`;

  useEffect(() => {
    onMetricsChange?.({
      visibleCount: measurement.layout.nodes.length,
      maxDepth: measurement.layout.maxDepth,
      layoutDurationMs: measurement.durationMs,
    });
  }, [measurement, onMetricsChange]);

  if (measurement.error) {
    return (
      <div className={cn("flex h-[680px] items-center justify-center bg-muted/20 p-6", className)} data-testid={testId}>
        <div className="max-w-md rounded-xl border bg-background p-5 text-center">
          <p className="font-medium">Could not render Mind Map</p>
          <p className="mt-2 text-sm text-muted-foreground">{measurement.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("h-[680px] bg-muted/20", className)} data-testid={testId}>
      <ReactFlow
        key={viewKey}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
        minZoom={0.08}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onPaneClick={() => onSelectedIdChange(null)}
        onNodeClick={(_, node) => onSelectedIdChange(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        {showMiniMap && <MiniMap pannable zoomable />}
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
