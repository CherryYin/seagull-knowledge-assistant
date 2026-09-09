import { request } from "./client";

export type MindMapLayoutMode = "balanced" | "right";
export type MindMapReferenceType = "source" | "source_chunk" | "evidence" | "claim" | "asset_block" | "note" | "wiki";
export type MindMapNodeKind = "topic" | "section" | "concept" | "claim" | "evidence" | "block" | "knowledge" | "question";

export interface MindMapRead {
  id: string;
  user_id: string;
  owner_type: "source" | "asset";
  owner_id: string;
  purpose: "document_overview" | "asset_outline" | "asset_reasoning";
  title: string;
  root_node_id: string;
  layout_mode: MindMapLayoutMode;
  version: number;
  basis_revision: Record<string, unknown>;
  generation_status: "manual" | "generating" | "ready" | "stale" | "failed";
  created_at: string;
  updated_at: string;
}

export interface MindMapNodeRead {
  id: string;
  map_id: string;
  display_id: number;
  parent_id: string | null;
  content: string;
  note?: string | null;
  position: number;
  collapsed: boolean;
  node_kind: MindMapNodeKind;
  updated_by: "human" | "agent" | "system";
  created_at: string;
  updated_at: string;
}

export interface MindMapReferenceRead {
  id: string;
  map_id: string;
  node_id: string;
  ref_type: MindMapReferenceType;
  ref_id: string;
  relation: string;
  fragment_selector?: Record<string, unknown> | null;
  created_at: string;
}

export interface MindMapTreeRead {
  map: MindMapRead;
  root_id: string;
  nodes: MindMapNodeRead[];
  references: MindMapReferenceRead[];
}

export interface MindMapMutationResult {
  map_id: string;
  previous_version: number;
  current_version: number;
  revision: {
    id: string;
    map_id: string;
    version: number;
    action: string;
    summary: string;
    created_at: string;
  };
  node?: MindMapNodeRead | null;
  reference?: MindMapReferenceRead | null;
  deleted_node_ids: string[];
}

export interface MindMapVersionConflict {
  code: "mind_map_version_conflict";
  message: string;
  map_id: string;
  expected_version: number;
  current_version: number;
}

interface MindMapNodeCreate {
  base_version: number;
  parent_id: string;
  content: string;
  note?: string | null;
  position?: number | null;
  node_kind: MindMapNodeKind;
  updated_by: "human";
}

interface MindMapNodeUpdate {
  base_version: number;
  content: string;
  note?: string | null;
  node_kind: MindMapNodeKind;
  updated_by: "human";
}

interface MindMapNodeMove {
  base_version: number;
  parent_id: string;
  position: number;
  updated_by: "human";
}

interface MindMapNodeDelete {
  base_version: number;
  delete_subtree: true;
  updated_by: "human";
}

export function getMindMapVersionConflict(error: unknown): MindMapVersionConflict | null {
  if (!(error instanceof Error) || !error.message.startsWith("409:")) return null;
  const jsonStart = error.message.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    const payload = JSON.parse(error.message.slice(jsonStart)) as { detail?: Partial<MindMapVersionConflict> };
    const detail = payload.detail;
    if (
      detail?.code !== "mind_map_version_conflict"
      || typeof detail.message !== "string"
      || typeof detail.map_id !== "string"
      || typeof detail.expected_version !== "number"
      || typeof detail.current_version !== "number"
    ) return null;
    return detail as MindMapVersionConflict;
  } catch {
    return null;
  }
}

export const mindMapsApi = {
  getTree: (mapId: string) => request<MindMapTreeRead>(`/mind-maps/${encodeURIComponent(mapId)}/tree`),
  addNode: (mapId: string, body: MindMapNodeCreate) => request<MindMapMutationResult>(
    `/mind-maps/${encodeURIComponent(mapId)}/nodes`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  updateNode: (mapId: string, nodeId: string, body: MindMapNodeUpdate) => request<MindMapMutationResult>(
    `/mind-maps/${encodeURIComponent(mapId)}/nodes/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  ),
  moveNode: (mapId: string, nodeId: string, body: MindMapNodeMove) => request<MindMapMutationResult>(
    `/mind-maps/${encodeURIComponent(mapId)}/nodes/${encodeURIComponent(nodeId)}/move`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  deleteNode: (mapId: string, nodeId: string, body: MindMapNodeDelete) => request<MindMapMutationResult>(
    `/mind-maps/${encodeURIComponent(mapId)}/nodes/${encodeURIComponent(nodeId)}`,
    { method: "DELETE", body: JSON.stringify(body) },
  ),
};
