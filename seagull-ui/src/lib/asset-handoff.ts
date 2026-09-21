import type { AssetStyleProfileId, AssetType } from "@/lib/api";
import { defaultAssetStyleProfile } from "@/lib/asset-generation";

export type ManualAssetType = Exclude<AssetType, "newsletter_issue">;

export interface AssetHandoffState {
  title?: string;
  brief?: string;
  audience?: string;
  style_notes?: string;
  style_profile_id?: AssetStyleProfileId;
  asset_type?: ManualAssetType;
  source_refs?: string[];
  note_refs?: string[];
  wiki_refs?: string[];
}

export interface AssetGenerationSeed {
  assetType: ManualAssetType;
  title: string;
  brief: string;
  audience: string;
  styleNotes: string;
  styleProfileId: AssetStyleProfileId;
  sourceRefs: string[];
  noteRefs: string[];
  wikiRefs: string[];
}

export function buildAssetHandoffState(input: AssetHandoffState): AssetHandoffState {
  return {
    title: input.title,
    brief: input.brief,
    audience: input.audience,
    style_notes: input.style_notes,
    style_profile_id: input.style_profile_id,
    asset_type: input.asset_type,
    source_refs: input.source_refs ?? [],
    note_refs: input.note_refs ?? [],
    wiki_refs: input.wiki_refs ?? [],
  };
}

export function buildAssetGenerationSeed(input?: AssetHandoffState): AssetGenerationSeed {
  return {
    assetType: input?.asset_type ?? "blog_post",
    title: input?.title ?? "",
    brief: input?.brief ?? "",
    audience: input?.audience ?? "",
    styleNotes: input?.style_notes ?? "",
    styleProfileId: input?.style_profile_id ?? defaultAssetStyleProfile(input?.asset_type ?? "blog_post"),
    sourceRefs: input?.source_refs ?? [],
    noteRefs: input?.note_refs ?? [],
    wikiRefs: input?.wiki_refs ?? [],
  };
}
