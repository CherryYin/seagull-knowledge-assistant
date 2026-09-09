import { ChevronDown, ChevronRight, Link2 } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface MindMapTreeNodeData extends Record<string, unknown> {
  label: string;
  depth: number;
  side: -1 | 0 | 1;
  displayId?: number;
  kind?: string;
  referenceCount: number;
  hasChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  onToggleCollapse?: (nodeId: string) => void;
}

export type MindMapFlowNode = Node<MindMapTreeNodeData, "mindMapTreeNode">;

export function MindMapTreeNode({ id, data }: NodeProps<MindMapFlowNode>) {
  const inwardPosition = data.side === -1 ? Position.Right : Position.Left;

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col justify-center rounded-xl border bg-background px-3 py-2 text-center shadow-[0_8px_24px_rgb(15_23_42/0.08)] transition-colors",
        data.depth === 0 && "rounded-2xl border-primary bg-primary text-primary-foreground",
        data.selected && data.depth !== 0 && "border-primary ring-2 ring-primary/20",
      )}
      data-testid={`mind-map-node-${id}`}
    >
      {data.depth > 0 && <Handle id={`target-${inwardPosition}`} type="target" position={inwardPosition} className="opacity-0" />}
      <Handle id="source-left" type="source" position={Position.Left} className="opacity-0" />
      <Handle id="source-right" type="source" position={Position.Right} className="opacity-0" />

      <div className="flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-wide opacity-75">
        {data.displayId != null && <span>#{data.displayId}</span>}
        {data.kind && <span>{data.kind}</span>}
      </div>
      <p className="line-clamp-3 text-xs font-medium leading-5">{data.label}</p>
      {(data.referenceCount > 0 || data.hasChildren) && (
        <div className="mt-1.5 flex items-center justify-center gap-1.5">
          {data.referenceCount > 0 && (
            <Badge variant={data.depth === 0 ? "secondary" : "outline"} className="h-5 gap-1 px-1.5 text-[10px]">
              <Link2 className="h-3 w-3" />
              {data.referenceCount}
            </Badge>
          )}
          {data.hasChildren && data.onToggleCollapse && (
            <button
              type="button"
              className={cn(
                "nodrag nopan inline-flex h-5 items-center gap-0.5 rounded px-1 text-[10px] hover:bg-muted",
                data.depth === 0 && "hover:bg-primary-foreground/15",
              )}
              aria-label={data.collapsed ? `Expand ${data.label}` : `Collapse ${data.label}`}
              onClick={(event) => {
                event.stopPropagation();
                data.onToggleCollapse?.(id);
              }}
            >
              {data.collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {data.collapsed ? "Expand" : "Collapse"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
