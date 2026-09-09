export type MindMapLayoutMode = "balanced" | "right";

export interface MindMapTreeNode {
  id: string;
  parentId: string | null;
  label: string;
}

export type MindMapPositionedNode<TNode extends MindMapTreeNode = MindMapTreeNode> = TNode & {
  depth: number;
  side: -1 | 0 | 1;
  position: { x: number; y: number };
  width: number;
  height: number;
};

export interface MindMapLayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface MindMapLayoutResult<TNode extends MindMapTreeNode = MindMapTreeNode> {
  nodes: MindMapPositionedNode<TNode>[];
  edges: MindMapLayoutEdge[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  maxDepth: number;
}

const NODE_WIDTH = 196;
const NODE_HEIGHT = 88;
const ROOT_WIDTH = 220;
const ROOT_HEIGHT = 96;
const LEVEL_GAP = 92;
const ROW_GAP = 28;

function buildChildren<TNode extends MindMapTreeNode>(nodes: TNode[]) {
  const children = new Map<string, TNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  return children;
}

export function createMindMapFixture(count: number): MindMapTreeNode[] {
  const size = Math.max(1, Math.floor(count));
  return Array.from({ length: size }, (_, index) => {
    const ordinal = index + 1;
    if (ordinal === 1) {
      return { id: "node-1", parentId: null, label: `Mind Map 技术验证 · ${size} nodes` };
    }
    const parentOrdinal = Math.floor((ordinal - 2) / 3) + 1;
    const longLabel = ordinal % 11 === 0
      ? "长文本节点：验证中文、English term 与多层知识结构的换行表现"
      : `Knowledge node ${ordinal}`;
    return { id: `node-${ordinal}`, parentId: `node-${parentOrdinal}`, label: longLabel };
  });
}

export function filterMindMapTree<TNode extends MindMapTreeNode>(
  nodes: TNode[],
  collapsedIds: ReadonlySet<string>,
  focusId: string | null,
): TNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = buildChildren(nodes);
  const root = focusId ? byId.get(focusId) : nodes.find((node) => node.parentId === null);
  if (!root) return [];

  const visible: TNode[] = [];
  const visit = (node: TNode, parentId: string | null) => {
    visible.push({ ...node, parentId } as TNode);
    if (collapsedIds.has(node.id)) return;
    for (const child of children.get(node.id) ?? []) visit(child, node.id);
  };
  visit(root, null);
  return visible;
}

export function layoutMindMapTree<TNode extends MindMapTreeNode>(
  nodes: TNode[],
  mode: MindMapLayoutMode,
): MindMapLayoutResult<TNode> {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, maxDepth: 0 };
  }

  const byId = new Map<string, TNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate Mind Map node ID: ${node.id}`);
    byId.set(node.id, node);
  }
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) throw new Error(`Mind Map requires exactly one root; received ${roots.length}`);
  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) throw new Error(`Missing parent ${node.parentId} for ${node.id}`);
  }

  const root = roots[0];
  const children = buildChildren(nodes);
  const leafWeights = new Map<string, number>();
  const calculateWeight = (nodeId: string, path: Set<string>): number => {
    if (path.has(nodeId)) throw new Error(`Mind Map cycle detected at ${nodeId}`);
    const cached = leafWeights.get(nodeId);
    if (cached !== undefined) return cached;
    const nextPath = new Set(path).add(nodeId);
    const descendants = children.get(nodeId) ?? [];
    const weight = descendants.length === 0
      ? 1
      : descendants.reduce((total, child) => total + calculateWeight(child.id, nextPath), 0);
    leafWeights.set(nodeId, weight);
    return weight;
  };
  calculateWeight(root.id, new Set());

  const rootChildren = children.get(root.id) ?? [];
  const rootSides = new Map<string, -1 | 1>();
  if (mode === "right") {
    for (const child of rootChildren) rootSides.set(child.id, 1);
  } else {
    let leftWeight = 0;
    let rightWeight = 0;
    for (const child of rootChildren) {
      const weight = leafWeights.get(child.id) ?? 1;
      const side = rightWeight <= leftWeight ? 1 : -1;
      rootSides.set(child.id, side);
      if (side === 1) rightWeight += weight;
      else leftWeight += weight;
    }
  }

  const centers = new Map<string, { x: number; y: number; depth: number; side: -1 | 0 | 1 }>();
  centers.set(root.id, { x: 0, y: 0, depth: 0, side: 0 });

  let maxDepth = 0;
  for (const side of [-1, 1] as const) {
    let cursor = 0;
    const sideNodeIds: string[] = [];
    const place = (node: TNode, depth: number): number => {
      maxDepth = Math.max(maxDepth, depth);
      sideNodeIds.push(node.id);
      const descendants = children.get(node.id) ?? [];
      let centerY: number;
      if (descendants.length === 0) {
        centerY = cursor * (NODE_HEIGHT + ROW_GAP);
        cursor += 1;
      } else {
        const childCenters = descendants.map((child) => place(child, depth + 1));
        centerY = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
      }
      centers.set(node.id, { x: side * depth * (NODE_WIDTH + LEVEL_GAP), y: centerY, depth, side });
      return centerY;
    };

    for (const child of rootChildren.filter((item) => rootSides.get(item.id) === side)) place(child, 1);
    if (sideNodeIds.length > 0) {
      const values = sideNodeIds.map((id) => centers.get(id)!.y);
      const shift = -((Math.min(...values) + Math.max(...values)) / 2);
      for (const id of sideNodeIds) {
        const current = centers.get(id)!;
        centers.set(id, { ...current, y: current.y + shift });
      }
    }
  }

  const positioned = nodes.map<MindMapPositionedNode<TNode>>((node) => {
    const center = centers.get(node.id);
    if (!center) throw new Error(`Mind Map node ${node.id} is disconnected from the root`);
    const width = node.id === root.id ? ROOT_WIDTH : NODE_WIDTH;
    const height = node.id === root.id ? ROOT_HEIGHT : NODE_HEIGHT;
    return {
      ...node,
      depth: center.depth,
      side: center.side,
      position: { x: center.x - width / 2, y: center.y - height / 2 },
      width,
      height,
    };
  });
  const edges = nodes
    .filter((node) => node.parentId)
    .map((node) => ({ id: `edge-${node.parentId}-${node.id}`, source: node.parentId!, target: node.id }));
  const bounds = positioned.reduce(
    (result, node) => ({
      minX: Math.min(result.minX, node.position.x),
      minY: Math.min(result.minY, node.position.y),
      maxX: Math.max(result.maxX, node.position.x + node.width),
      maxY: Math.max(result.maxY, node.position.y + node.height),
    }),
    { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
  );

  return { nodes: positioned, edges, bounds, maxDepth };
}
