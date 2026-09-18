import { useMemo, useState } from "react";
import {
  MindMapCanvas,
  type MindMapCanvasMetrics,
} from "@/components/mind-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createMindMapFixture,
  type MindMapLayoutMode,
} from "@/lib/mind-map-layout";

const NODE_COUNTS = [20, 100, 300] as const;

export function MindMapSpikePage() {
  const [nodeCount, setNodeCount] = useState<(typeof NODE_COUNTS)[number]>(100);
  const [layoutMode, setLayoutMode] = useState<MindMapLayoutMode>("balanced");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MindMapCanvasMetrics>({
    visibleCount: 0,
    maxDepth: 0,
    layoutDurationMs: 0,
  });

  const fixture = useMemo(() => createMindMapFixture(nodeCount), [nodeCount]);
  const childrenByParent = useMemo(() => {
    const result = new Map<string, number>();
    for (const node of fixture) {
      if (node.parentId) result.set(node.parentId, (result.get(node.parentId) ?? 0) + 1);
    }
    return result;
  }, [fixture]);
  const selectedNode = fixture.find((node) => node.id === selectedId) ?? null;
  const selectedHasChildren = selectedId ? (childrenByParent.get(selectedId) ?? 0) > 0 : false;

  const resetFixture = (count: (typeof NODE_COUNTS)[number]) => {
    setNodeCount(count);
    setCollapsedIds(new Set());
    setFocusId(null);
    setSelectedId(null);
  };

  return (
    <div className="space-y-6" data-testid="mind-map-spike">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Mind Map Technical Spike</h1>
          <Badge variant="outline">Development only</Badge>
          <Badge variant="secondary">M0</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Validates an independently implemented XYFlow tree layout before PDF Source or Asset persistence is introduced.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Benchmark Controls</CardTitle>
          <CardDescription>Switch fixture size and layout mode, then verify collapse and focus behavior.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {NODE_COUNTS.map((count) => (
              <Button key={count} type="button" variant={nodeCount === count ? "default" : "outline"} onClick={() => resetFixture(count)}>
                {count} nodes
              </Button>
            ))}
            <span className="mx-1 h-6 w-px bg-border" />
            <Button type="button" variant={layoutMode === "balanced" ? "default" : "outline"} onClick={() => setLayoutMode("balanced")}>Balanced</Button>
            <Button type="button" variant={layoutMode === "right" ? "default" : "outline"} onClick={() => setLayoutMode("right")}>Right</Button>
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Fixture nodes" value={String(nodeCount)} />
            <Metric label="Visible nodes" value={String(metrics.visibleCount)} testId="mind-map-visible-count" />
            <Metric label="Max depth" value={String(metrics.maxDepth)} />
            <Metric label="Layout time" value={`${metrics.layoutDurationMs.toFixed(2)} ms`} testId="mind-map-layout-duration" />
            <Metric label="Mode" value={layoutMode} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selectedNode || !selectedHasChildren}
              onClick={() => {
                if (!selectedId) return;
                setCollapsedIds((current) => {
                  const next = new Set(current);
                  if (next.has(selectedId)) next.delete(selectedId);
                  else next.add(selectedId);
                  return next;
                });
              }}
            >
              {selectedId && collapsedIds.has(selectedId) ? "Expand selected" : "Collapse selected"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={!selectedNode} onClick={() => setFocusId(selectedId)}>Focus selected</Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setFocusId(null);
                setCollapsedIds(new Set());
                setSelectedId(null);
              }}
            >
              Reset view
            </Button>
            <span className="text-xs text-muted-foreground">
              {selectedNode ? `Selected ${selectedNode.id}: ${selectedNode.label}` : "Select a node to test focus and collapse."}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <MindMapCanvas
            nodes={fixture}
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
    </div>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium" data-testid={testId}>{value}</p>
    </div>
  );
}
