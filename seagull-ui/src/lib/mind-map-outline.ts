import type { MindMapNodeRead } from "@/lib/api/mind-maps";

export function buildMindMapOutline(nodes: MindMapNodeRead[]): string {
  if (nodes.length === 0) return "";

  const root = nodes.find((node) => node.parent_id === null);
  if (!root) return "";

  const childrenByParent = new Map<string, MindMapNodeRead[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const children = childrenByParent.get(node.parent_id) ?? [];
    children.push(node);
    childrenByParent.set(node.parent_id, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.position - right.position || left.display_id - right.display_id);
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (node: MindMapNodeRead, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    lines.push(`${"  ".repeat(depth)}- [id:${node.display_id}] ${node.content}`);
    for (const child of childrenByParent.get(node.id) ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines.join("\n");
}
