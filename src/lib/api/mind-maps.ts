import { request } from "./client";

export type MindMapLayoutMode = "balanced" | "right";
export type MindMapReferenceType = "source" | "source_chunk" | "evidence" | "claim" | "asset_block" | "note" | "wiki";

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
  node_kind: string;
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

export const mindMapsApi = {
  getTree: (mapId: string) => request<MindMapTreeRead>(`/mind-maps/${encodeURIComponent(mapId)}/tree`),
};
